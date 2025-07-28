/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests the statistics and other counters reported through telemetry.
 */

"use strict";

// Globals

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// To prevent intermittent failures when the test is executed at a time that is
// very close to a day boundary, we make it deterministic by using a static
// reference date for all the time-based statistics.
const gReferenceTimeMs = new Date("2000-01-01T00:00:00").getTime();

// Returns a milliseconds value to use with nsILoginMetaInfo properties, falling
// approximately in the middle of the specified number of days before the
// reference time, where zero days indicates a time within the past 24 hours.
const daysBeforeMs = days => gReferenceTimeMs - (days + 0.5) * MS_PER_DAY;

/**
 * Contains metadata that will be attached to test logins in order to verify
 * that the statistics collection is working properly. Most properties of the
 * logins are initialized to the default test values already.
 *
 * If you update this data or any of the telemetry histograms it checks, you'll
 * probably need to update the expected statistics in the test below.
 */
const StatisticsTestData = [
  {
    timeLastUsed: daysBeforeMs(0),
  },
  {
    timeLastUsed: daysBeforeMs(1),
  },
  {
    timeLastUsed: daysBeforeMs(7),
    formActionOrigin: null,
    httpRealm: "The HTTP Realm",
  },
  {
    username: "",
    timeLastUsed: daysBeforeMs(7),
  },
  {
    username: "",
    timeLastUsed: daysBeforeMs(30),
  },
  {
    username: "",
    timeLastUsed: daysBeforeMs(31),
  },
  {
    timeLastUsed: daysBeforeMs(365),
  },
  {
    username: "",
    timeLastUsed: daysBeforeMs(366),
  },
  {
    // If the login was saved in the future, it is ignored for statistiscs.
    timeLastUsed: daysBeforeMs(-1),
  },
  {
    timeLastUsed: daysBeforeMs(1000),
  },
];

// Tests

/**
 * Enable FOG and prepare the test data.
 */
add_setup(async () => {
  // FOG needs a profile directory to put its data in.
  do_get_profile();
  // FOG needs to be initialized, or testGetValue() calls will deadlock.
  Services.fog.initializeFOG();

  let uniqueNumber = 1;
  let logins = [];
  for (let loginModifications of StatisticsTestData) {
    loginModifications.origin = `http://${uniqueNumber++}.example.com`;
    if (typeof loginModifications.httpRealm != "undefined") {
      logins.push(TestData.authLogin(loginModifications));
    } else {
      logins.push(TestData.formLogin(loginModifications));
    }
  }
  await Services.logins.addLogins(logins);
});

/*
 * Tests that the number of saved logins is appropriately reported.
 */
add_task(function test_logins_count() {
  Assert.equal(
    Glean.pwmgr.numSavedPasswords.testGetValue(),
    StatisticsTestData.length,
    "We've appropriately counted all the logins"
  );
});

/**
 * Tests the collection of statistics related to general settings.
 */
add_task(function test_settings_statistics() {
  let oldRememberSignons = Services.prefs.getBoolPref("signon.rememberSignons");
  registerCleanupFunction(function () {
    Services.prefs.setBoolPref("signon.rememberSignons", oldRememberSignons);
  });

  for (let remember of [false, true]) {
    // This change should be observed immediately by the login service.
    Services.prefs.setBoolPref("signon.rememberSignons", remember);
    Assert.equal(
      Glean.pwmgr.savingEnabled.testGetValue(),
      remember,
      "The pref is correctly recorded."
    );
  }
});

/*
 * Tests that the number of saved logins is appropriately reported to
 * the rust storage.
 */
add_task(async function test_logins_diff_count_rust_storage() {
  const expectedDiff = 0;

  // Wait for observer to ensure that Rust metric was set
  await TestUtils.waitForCondition(() => {
    return Glean.pwmgr.diffSavedPasswordsRust.testGetValue() === expectedDiff;
  }, `Waiting for Rust telemetry to report ${expectedDiff} saved passwords`);

  Assert.equal(
    Glean.pwmgr.diffSavedPasswordsRust.testGetValue(),
    expectedDiff,
    "Rust and JSON storage should have the same number of saved passwords"
  );
});

/*
 * Tests that an error is logged when adding an invalid login to the Rust store.
 * The Rust store is stricter than the JSON store and rejects some formats,
 * such as certain non-ASCII origins.
 */
add_task(async function test_rust_mirror_addLogin_failure() {
  // Flush + reset Glean state to start clean
  await Services.fog.testFlushAllChildren();
  Services.fog.testResetFOG();

  const badLogin = LoginTestUtils.testData.formLogin({
    origin: "https://.", // invalid origin for Rust
    formActionOrigin: "https://example.org/",
    username: "baduser",
    password: "badpass",
  });

  info("Attempting to add login with invalid origin that Rust cannot parse...");

  // addLoginAsync should succeed in JSON, but Rust will fail in the mirror
  await Services.logins.addLoginAsync(badLogin);

  // Wait for microtask + Rust mirror flush
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  await Services.fog.testFlushAllChildren();

  const events = Glean.pwmgr.rustMigrationFailure.testGetValue();
  Assert.ok(
    events.length >= 1,
    "At least one rustMigrationFailure event was recorded"
  );

  const addEvent = events.find(e => e.extra?.operation === "add");
  Assert.ok(addEvent, "An 'add' failure event was recorded");

  Assert.ok(
    typeof addEvent.extra.error_message === "string" &&
      !!addEvent.extra.error_message.length,
    "The error_message field should contain the error string"
  );
});

// TODO tests for login remove, intit, migration fail etc

/*
 * Tests that we collect telemetry if non-ASCII origins get punycoded.
 */
add_task(async function test_punycode_origin_metric() {
  await Services.fog.testFlushAllChildren();
  Services.fog.testResetFOG();

  const badOrigin = "https://münich.example.com";
  const login = LoginTestUtils.testData.formLogin({
    origin: badOrigin,
    formActionOrigin: "https://example.com",
    username: "user1",
    password: "pass1",
  });

  await Services.logins.addLoginAsync(login);

  await TestUtils.waitForCondition(
    () => Glean.pwmgr.invalidLoginFormat.nonAsciiOrigin.testGetValue() === 1
  );

  Assert.equal(
    Glean.pwmgr.originPunycodeUsed.origin.testGetValue(),
    1,
    "Punycode telemetry for `origin` should be incremented"
  );
});

/*
 * Tests that we collect telemetry if non-ASCII formorigins get punycoded.
 */
add_task(async function test_punycode_formActionOrigin_metric() {
  await Services.fog.testFlushAllChildren();
  Services.fog.testResetFOG();

  const badFormActionOrigin = "https://münich.example.org";
  const login = LoginTestUtils.testData.formLogin({
    origin: "https://example.org",
    formActionOrigin: badFormActionOrigin,
    username: "user2",
    password: "pass2",
  });

  await Services.logins.addLoginAsync(login);

  await TestUtils.waitForCondition(
    () => Glean.pwmgr.invalidLoginFormat.nonAsciiFormOrigin.testGetValue() === 1
  );

  Assert.equal(
    Glean.pwmgr.originPunycodeUsed.formActionOrigin.testGetValue(),
    1,
    "Punycode telemetry for `formActionOrigin` should be incremented"
  );
});

/*
 * Tests that we collect telemetry for single dot in origin
 */
add_task(async function test_dot_in_origin_triggers_telemetry() {
  await Services.fog.testFlushAllChildren();
  Services.fog.testResetFOG();

  const badLogin = LoginTestUtils.testData.formLogin({
    origin: ".", // technically valid in JSON, problematic for Rust
    formActionOrigin: "https://example.org",
    username: "dotuser",
    password: "dotpass",
  });

  await Services.logins.addLoginAsync(badLogin);

  await Services.fog.testFlushAllChildren();

  Assert.equal(
    Glean.pwmgr.invalidLoginFormat.dotOrigin.testGetValue(),
    1,
    "Glean telemetry for dotOrigin should be incremented"
  );
});

/*
 * Tests that we collect telemetry for single dot in formorigin
 */
add_task(async function test_dot_in_formActionOrigin_triggers_telemetry() {
  await Services.fog.testFlushAllChildren();
  Services.fog.testResetFOG();

  const badLogin = LoginTestUtils.testData.formLogin({
    origin: "https://example.com",
    formActionOrigin: ".", // triggers telemetry
    username: "formuser",
    password: "formpass",
  });

  await Services.logins.addLoginAsync(badLogin);

  await Services.fog.testFlushAllChildren();

  Assert.equal(
    Glean.pwmgr.invalidLoginFormat.dotFormActionOrigin.testGetValue(),
    1,
    "Glean telemetry for dotFormActionOrigin should be incremented"
  );
});
