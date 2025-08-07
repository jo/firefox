/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests the AS RustLogins write-only mirror
 */

const { LoginManagerRustStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/storage-rust.sys.mjs"
);
const { LoginManagerStorage } = ChromeUtils.importESModule(
  "resource://passwordmgr/passwordstorage.sys.mjs"
);
const sinon = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
).sinon;

("use strict");

/**
 * Enable Rust mirror
 */
add_setup(async () => {
  Services.prefs.setBoolPref("signon.loginsRustMirror.enabled", true);
});

/**
 * Tests addLogin gets synced to Rust Storage
 */
add_task(async function test_mirror_addLogin() {
  const loginInfo = TestData.formLogin({
    username: "username",
    password: "password",
  });
  await Services.logins.addLoginAsync(loginInfo);
  await LoginTestUtils.reloadData();
  await LoginTestUtils.checkLogins([loginInfo]);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const [storedLoginInfo] = await Services.logins.getAllLogins();

  const [rustStoredLoginInfo] = await rustStorage.searchLoginsAsync({
    guid: storedLoginInfo.guid,
  });
  LoginTestUtils.assertLoginListsEqual(
    [storedLoginInfo],
    [rustStoredLoginInfo]
  );

  LoginTestUtils.clearData();
});

/**
 * Tests modifyLogin gets synced to Rust Storage
 */
add_task(async function test_mirror_modifyLogin() {
  const loginInfo = TestData.formLogin({
    username: "username",
    password: "password",
  });
  await Services.logins.addLoginAsync(loginInfo);
  await LoginTestUtils.reloadData();
  await LoginTestUtils.checkLogins([loginInfo]);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const [storedLoginInfo] = await Services.logins.getAllLogins();

  const modifiedLoginInfo = TestData.formLogin({
    username: "username",
    password: "password",
    usernameField: "new_form_field_username",
    passwordField: "new_form_field_password",
  });
  Services.logins.modifyLogin(storedLoginInfo, modifiedLoginInfo);

  const [storedModifiedLoginInfo] = await Services.logins.getAllLogins();

  const [rustStoredModifiedLoginInfo] = await rustStorage.searchLoginsAsync({
    guid: storedLoginInfo.guid,
  });
  LoginTestUtils.assertLoginListsEqual(
    [storedModifiedLoginInfo],
    [rustStoredModifiedLoginInfo]
  );

  await LoginTestUtils.clearData();
});

/**
 * Tests removeLogin gets synced to Rust Storage
 */
add_task(async function test_mirror_removeLogin() {
  const loginInfo = TestData.formLogin({
    username: "username",
    password: "password",
  });
  await Services.logins.addLoginAsync(loginInfo);
  await LoginTestUtils.reloadData();
  await LoginTestUtils.checkLogins([loginInfo]);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const [storedLoginInfo] = await Services.logins.getAllLogins();

  Services.logins.removeLogin(storedLoginInfo);

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(allLogins.length, 0);

  await LoginTestUtils.clearData();
});

/**
 * Tests initial rolling migration from JSON to RUST store.
 */
add_task(async function test_rolling_migration_initial_copy() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
    Services.logins,
    rustStorage
  );

  const jsonLogins = await Services.logins.getAllLogins();
  const rustLogins = await rustStorage.getAllLogins();

  LoginTestUtils.assertLoginListsEqual(jsonLogins, rustLogins);

  await LoginTestUtils.clearData();
});

/**
 * Verifies that the rolling migration is idempotent by ensuring that running
 * it multiple times does not create duplicate logins in the Rust store.
 */
add_task(async function test_migration_is_idempotent() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStore = new LoginManagerRustStorage();
  await rustStore.initialize();

  // Second migration (first one runs on init)
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
    Services.logins,
    rustStore
  );
  let loginsAfterFirst = await rustStore.getAllLogins();
  Assert.equal(loginsAfterFirst.length, 1, "Login copied on first migration");

  // Third migration (simulate re-run)
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
    Services.logins,
    rustStore
  );
  let loginsAfterSecond = await rustStore.getAllLogins();
  Assert.equal(
    loginsAfterSecond.length,
    1,
    "No duplicate after second migration"
  );

  await LoginTestUtils.clearData();
});

/**
 * Verifies that the Rust store is reset and re-migrated when the JSON store checksum changes,
 * ensuring outdated or mismatched logins are dropped.
 */
add_task(async function test_rolling_migration_drops_rust_on_checksum_change() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  // Step 2: Run first migration
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
    Services.logins,
    rustStorage
  );

  let rustLogins = await rustStorage.getAllLogins();
  LoginTestUtils.assertLoginListsEqual(
    rustLogins,
    [login],
    "Rust store should contain original login after first migration"
  );

  // Step 3: Mutate JSON store to change checksum
  await Services.logins.removeAllLogins();
  const newLogin = TestData.formLogin({
    username: "test-user-2",
    password: "secure-password-2",
  });
  await Services.logins.addLoginAsync(newLogin);

  // Step 4: Run second migration (checksum mismatch expected)
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
    Services.logins,
    rustStorage
  );

  let rustLoginsAfter = await rustStorage.getAllLogins();
  LoginTestUtils.assertLoginListsEqual(
    rustLoginsAfter,
    [newLogin],
    "Rust store should only contain new login after second migration"
  );

  await LoginTestUtils.clearData();
});

/**
 * Verifies that all critical login fields are correctly mirrored from the
 * JSON store to the Rust store.
 */
add_task(async function test_mirror_login_fields_are_complete() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();
  await LoginTestUtils.reloadData();

  const stored = await Services.logins.getAllLogins();
  const mirrored = await rustStorage.getAllLogins();

  LoginTestUtils.assertLoginListsEqual(
    stored,
    mirrored,
    "Rust store is in sync"
  );

  await LoginTestUtils.clearData();
});

/**
 * Verifies that the rolling migration avoids redundant updates by not
 * attempting to re-add logins that haven't changed since the last migration.
 */
add_task(async function test_avoid_redundant_updates() {
  const login = TestData.formLogin({
    username: "test-user",
    password: "secure-password",
  });
  await Services.logins.addLoginAsync(login);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  // First migration - triggers real copy
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
    Services.logins,
    rustStorage
  );

  // Stub addLoginsAsync to observe the second call
  const stub = sinon.stub(rustStorage, "addLoginsAsync");

  // Second migration - should not call addLoginAsync again
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
    Services.logins,
    rustStorage
  );

  Assert.ok(stub.notCalled, "Should skip unchanged login migration");

  stub.restore();

  await LoginTestUtils.clearData();
});

/**
 * Tests that rolling migration aborts on partial failure.
 * If one login fails to migrate, none should be written to Rust storage.
 * Ensures consistency by preventing partially migrated state. The second
 * login would succeed if attempted, but the migration logic is expected
 * to abort on the first error.
 */
add_task(async function test_migration_aborts_on_partial_failure() {
  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const loginA = TestData.formLogin({ username: "userA" });
  const loginB = TestData.formLogin({ username: "userB" });

  await Services.logins.addLogins([loginA, loginB]);

  sinon.stub(rustStorage, "getCheckpoint").returns("forced-checksum-mismatch");

  const stub = sinon
    .stub(rustStorage, "addLoginsAsync")
    .onFirstCall()
    .rejects(new Error("Simulated migration failure"));

  try {
    await Assert.rejects(
      LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage),
      /Simulated migration failure/,
      "Migration should fail when one login fails to copy"
    );

    const migratedLogins = await rustStorage.getAllLogins();
    Assert.equal(
      migratedLogins.length,
      0,
      "No logins should be migrated if one fails"
    );
  } finally {
    stub.restore();
    await LoginTestUtils.clearData();
  }
});

/**
 * Ensures that migrating a large number of logins (100) from the JSON store to
 * the Rust store completes within a reasonable time frame (under 1 second).
 **/
add_task(async function test_migration_time_under_threshold() {
  const logins = Array.from({ length: 100}, (_, i) =>
    TestData.formLogin({ username: `user${i}` })
  );
  await Services.logins.addLogins(logins);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();
  
  sinon.stub(rustStorage, "getCheckpoint").returns("force-migration");
  const start = Date.now();
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage);
  const duration = Date.now() - start;

  Assert.less(duration, 1000, "Migration should complete under 1s");
});

/*
 * Tests that the number of saved logins is appropriately reported to
 * the rust storage.
 */

add_setup(async () => {
  // Required for FOG/Glean to work correctly in tests
  do_get_profile();
  Services.fog.initializeFOG();
});

add_task(async function test_logins_diff_count_rust_storage() {
  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  // Add login to JSON store
  const login = TestData.formLogin({ username: "glean_user" });
  await Services.logins.addLoginAsync(login);

  // Force a migration by stubbing the checkpoint
  sinon.stub(rustStorage, "getCheckpoint").returns("force-migration");
  const expectedDiff = 0;

  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
    Services.logins,
    rustStorage
  );

  Assert.equal(
    Glean.pwmgr.diffSavedPasswordsRust.testGetValue(),
    expectedDiff,
    "Rust and JSON storage should have the same number of saved passwords"
   );
 });

 // TODO (remove) Test I wrote to trying to get the the error from the Rust store, but it doesn't fail
 add_task(async function test_rust_storage_addLogin_dot() {
  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const loginInfo = TestData.formLogin({ origin: ".", passwordField: "." });

  loginInfo.QueryInterface(Ci.nsILoginMetaInfo);
  loginInfo.guid = Services.uuid.generateUUID().toString();

  await rustStorage.addLoginsAsync([loginInfo]);
});


/*
 * Tests that an error is logged when adding an invalid login to the Rust store.
 * The Rust store is stricter than the JSON store and rejects some formats,
 * such as certain non-ASCII origins.
 */
// add_task(async function test_rust_mirror_addLogin_failure() {
//   // This login will be accepted by JSON but rejected by Rust
//   const badLogin = TestData.formLogin({ origin: ".", passwordField: "." });

//   await Services.logins.addLoginAsync(badLogin);
//   await LoginTestUtils.reloadData();

//   info("Init rust store to trigger mirror..");
//   const rustStorage = new LoginManagerRustStorage();
//   await rustStorage.initialize();

//   const results = await rustStorage.searchLoginsAsync({
//     origin: badLogin.origin,
//   });
  
//   console.log("Rust logins found:", results.length);
//   for (const login of results) {
//     console.log(`→ Found login with origin: ${login.origin}, guid: ${login.guid}`);
//   }
  
//   const events = Glean.pwmgr.rustMigrationFailure.testGetValue();
//   console.log("Glean rustMigrationFailure events:", events);
//   Assert.ok(events, "Expected rustMigrationFailure events to be present");

//   const addEvent = events.find(e => e.extra?.operation === "add");
//   Assert.ok(addEvent, "An 'add' failure event was recorded");

//   Assert.ok(
//     typeof addEvent.extra.error_message === "string" &&
//       !!addEvent.extra.error_message.length,
//     "The error_message field should contain the error string"
//   );
// });

//TODO tests for login remove, intit, migration fail etc

/*
 * Tests that we collect telemetry if non-ASCII origins get punycoded.
 */
add_task(async function test_punycode_origin_metric() {
  const badOrigin = "https://münich.example.com";
  const login = LoginTestUtils.testData.formLogin({
    origin: badOrigin,
    formActionOrigin: "https://example.com",
    username: "user1",
    password: "pass1",
  });

  await Services.logins.addLoginAsync(login);

  Assert.equal(
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiOrigin.testGetValue(),
    1,
    "Punycode telemetry for `origin` should be incremented"
  );
});

/*
 * Tests that we collect telemetry if non-ASCII formorigins get punycoded.
 */
add_task(async function test_punycode_formActionOrigin_metric() {
  const badFormActionOrigin = "https://münich.example.org";
  const login = LoginTestUtils.testData.formLogin({
    origin: "https://example.org",
    formActionOrigin: badFormActionOrigin,
    username: "user2",
    password: "pass2",
  });

  await Services.logins.addLoginAsync(login);

  Assert.equal(
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiFormAction.testGetValue(),
    1,
    "Punycode telemetry for `formActionOrigin` should be incremented"
  );
});

/*
 * Tests that we collect telemetry for single dot in origin
 */
add_task(async function test_dot_in_origin_triggers_telemetry() {
  const badLogin = LoginTestUtils.testData.formLogin({
    origin: ".", // technically valid in JSON, problematic for Rust
    formActionOrigin: "https://example.org",
    username: "dotuser",
    password: "dotpass",
  });

  await Services.logins.addLoginAsync(badLogin);

  Assert.equal(
    Glean.pwmgr.rustIncompatibleLoginFormat.dotOrigin.testGetValue(),
    1,
    "Glean telemetry for dotOrigin should be incremented"
  );
});

/*
 * Tests that we collect telemetry for single dot in formorigin
 */
// add_task(async function test_dot_in_formActionOrigin_triggers_telemetry() {
//   do_get_profile();
//   Services.fog.initializeFOG();
//   await Services.fog.testFlushAllChildren();
//   Services.fog.testResetFOG();

//   const badLogin = LoginTestUtils.testData.formLogin({
//     origin: "https://example.com",
//     formActionOrigin: ".", // triggers telemetry
//     username: "formuser",
//     password: "formpass",
//   });

//   await Services.logins.addLoginAsync(badLogin);

//   Assert.equal(
//     Glean.pwmgr.rustIncompatibleLoginFormat.dotFormAction.testGetValue(),
//     1,
//     "Glean telemetry for dotFormActionOrigin should be incremented"
//   );
// });
