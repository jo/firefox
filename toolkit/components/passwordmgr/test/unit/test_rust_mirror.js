/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 *
 * Tests the AS RustLogins write-only mirror
 */

const { LoginManagerRustStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/storage-rust.sys.mjs"
);
const { LoginManagerRustMirror } = ChromeUtils.importESModule(
  "resource://gre/modules/LoginManagerRustMirror.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

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

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const storedLoginInfos = await Services.logins.getAllLogins();
  const rustStoredLoginInfos = await rustStorage.getAllLogins();
  LoginTestUtils.assertLoginListsEqual(storedLoginInfos, rustStoredLoginInfos);

  LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
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
  rustStorage.removeAllLogins();
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

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const [storedLoginInfo] = await Services.logins.getAllLogins();

  Services.logins.removeLogin(storedLoginInfo);

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(allLogins.length, 0);

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
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

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();
  await mirror.maybeRunRollingMigrationToRustStorage();
  await mirror.maybeRunRollingMigrationToRustStorage();

  let rustLogins = await rustStorage.getAllLogins();
  Assert.equal(rustLogins.length, 1, "No duplicate after second migration");

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
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

  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();
  await mirror.maybeRunRollingMigrationToRustStorage();

  // Step 2: Mutate JSON store to change checksum
  await Services.logins.removeAllLogins();
  const newLogin = TestData.formLogin({
    username: "test-user-2",
    password: "secure-password-2",
  });
  await Services.logins.addLoginAsync(newLogin);

  // Step 3: Run second migration (checksum mismatch expected)
  await mirror.maybeRunRollingMigrationToRustStorage();

  let rustLoginsAfter = await rustStorage.getAllLogins();
  LoginTestUtils.assertLoginListsEqual(
    rustLoginsAfter,
    [newLogin],
    "Rust store should only contain new login after second migration"
  );

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
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

  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();
  await mirror.maybeRunRollingMigrationToRustStorage();

  // Stub addLoginsAsync to observe the second call
  const stub = sinon.stub(rustStorage, "addLoginsAsync");

  // Second migration - should not call addLoginAsync again
  await mirror.maybeRunRollingMigrationToRustStorage();

  Assert.ok(stub.notCalled, "Should skip unchanged login migration");

  stub.restore();

  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});

// /**
//  * Tests that rolling migration aborts on partial failure.
//  * If one login fails to migrate, none should be written to Rust storage.
//  * Ensures consistency by preventing partially migrated state. The second
//  * login would succeed if attempted, but the migration logic is expected
//  * to abort on the first error.
//  */
// add_task(async function test_migration_aborts_on_partial_failure() {
//   const rustStorage = new LoginManagerRustStorage();
//   await rustStorage.initialize();
//
//   const loginA = TestData.formLogin({ username: "userA" });
//   const loginB = TestData.formLogin({ username: "userB" });
//
//   await Services.logins.addLogins([loginA, loginB]);
//
//   sinon.stub(rustStorage, "getCheckpoint").returns("forced-checksum-mismatch");
//
//   const stub = sinon
//     .stub(rustStorage, "addLoginsAsync")
//     .onFirstCall()
//     .rejects(new Error("Simulated migration failure"));
//
//   try {
//     await Assert.rejects(
//       LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage),
//       /Simulated migration failure/,
//       "Migration should fail when one login fails to copy"
//     );
//
//     const migratedLogins = await rustStorage.getAllLogins();
//     Assert.equal(
//       migratedLogins.length,
//       0,
//       "No logins should be migrated if one fails"
//     );
//   } finally {
//     stub.restore();
//     await LoginTestUtils.clearData();
//   }
// });

/**
 * Ensures that migrating a large number of logins (100) from the JSON store to
 * the Rust store completes within a reasonable time frame (under 1 second).
 **/
add_task(async function test_migration_time_under_threshold() {
  const numberOfLogins = 100;
  Services.prefs.setBoolPref("signon.loginsRustMirror.enabled", false);

  const logins = Array.from({ length: numberOfLogins }, (_, i) =>
    TestData.formLogin({
      origin: `https://www${i}.example.com`,
      username: `user${i}`,
    })
  );
  await Services.logins.addLogins(logins);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  Services.prefs.setBoolPref("signon.loginsRustMirror.enabled", true);
  const mirror = new LoginManagerRustMirror(Services.logins, rustStorage);
  await mirror.enable();
  sinon.stub(rustStorage, "getCheckpoint").returns("force-migration");

  const start = Date.now();
  await mirror.maybeRunRollingMigrationToRustStorage();
  const duration = Date.now() - start;

  Assert.less(duration, 1000, "Migration should complete under 1s");

  Assert.equal(rustStorage.countLogins("", "", ""), numberOfLogins);
  await LoginTestUtils.clearData();
  rustStorage.removeAllLogins();
});
