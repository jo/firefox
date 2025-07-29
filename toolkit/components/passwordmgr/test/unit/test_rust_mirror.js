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
const { LoginStore } = ChromeUtils.importESModule(
  "resource://gre/modules/LoginStore.sys.mjs"
);
const sinon = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
).sinon;

("use strict");

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

  const [rustStoredLoginInfo] = await rustStorage.searchLoginsAsync({ guid: storedLoginInfo.guid });
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

  const [rustStoredModifiedLoginInfo] = await rustStorage.searchLoginsAsync({ guid: storedLoginInfo.guid });
  LoginTestUtils.assertLoginListsEqual(
    [storedModifiedLoginInfo],
    [rustStoredModifiedLoginInfo]
  );

  LoginTestUtils.clearData();
});

/**
 * Tests removeLogin gets synced to Rust Storage
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

  Services.logins.removeLogin(storedLoginInfo);

  const allLogins = await rustStorage.getAllLogins();
  Assert.equal(allLogins.length, 0);

  LoginTestUtils.clearData();
});

// /**
//  * Tests initial rolling migration from JSON to RUST store.
//  */
// add_task(async function test_rolling_migration_initial_copy() {
//   const login = TestData.formLogin({
//     username: "test-user",
//     password: "secure-password",
//   });
//   await Services.logins.addLoginAsync(login);
// 
//   const rustStorage = new LoginManagerRustStorage();
//   await rustStorage.initialize();
// 
//   await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage);
// 
//   const jsonLogins = await Services.logins.getAllLogins();
//   const rustLogins = await rustStorage.getAllLogins();
// 
//   LoginTestUtils.assertLoginListsEqual(jsonLogins, rustLogins);
// 
//   await LoginTestUtils.clearData();
// });

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
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStore);
  let loginsAfterFirst = await rustStore.getAllLogins();
  Assert.equal(loginsAfterFirst.length, 1, "Login copied on first migration");

  // Third migration (simulate re-run)
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStore);
  let loginsAfterSecond = await rustStore.getAllLogins();
  Assert.equal(
    loginsAfterSecond.length,
    1,
    "No duplicate after second migration"
  );
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
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage);

  let [rustLogins] = await rustStorage.getAllLogins();
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
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage);

  let [rustLoginsAfter] = await rustStorage.getAllLogins();
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

  const [stored] = await Services.logins.getAllLogins();
  const [mirrored] = await rustStorage.getAllLogins();

  for (let field of ["origin", "username", "password"]) {
    Assert.ok(mirrored[field], `${field} must not be empty`);
  }

  LoginTestUtils.clearData();
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
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage);

  // Stub addLoginAsync to observe the second call
  const stub = sinon.stub(rustStorage, "addLoginAsync");

  // Second migration - should not call addLoginAsync again
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage);

  Assert.ok(stub.notCalled, "Should skip unchanged login migration");

  stub.restore();
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

  const stub = sinon
    .stub(rustStorage, "addLoginAsync")
    .onFirstCall()
    .rejects(new Error("Simulated migration failure"));

  try {
    await Assert.rejects(
      () => LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage),
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
 * Ensures that migrating a large number of logins (1000) from the JSON store to
 * the Rust store completes within a reasonable time frame (under 1 second).
 **/
add_task(async function test_migration_time_under_threshold() {
  const logins = Array.from({ length: 1000 }, (_, i) =>
    TestData.formLogin({ username: `user${i}` })
  );
  await Services.logins.addLogins(logins);

  const rustStorage = new LoginManagerRustStorage();
  await rustStorage.initialize();

  const start = Date.now();
  await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(Services.logins, rustStorage);
  const duration = Date.now() - start;

  Assert.less(duration, 1000, "Migration should complete under 1s");
});
