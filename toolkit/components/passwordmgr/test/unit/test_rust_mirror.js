/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests the AS RustLogins write-only mirror
 */

const { LoginManagerRustStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/storage-rust.sys.mjs"
);

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

  const rustStoredLoginInfo = rustStorage.store.get(storedLoginInfo.guid);
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

  const rustStoredModifiedLoginInfo = rustStorage.store.get(
    storedLoginInfo.guid
  );
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

  const allLogins = rustStorage.store.list();
  Assert.equal(allLogins.length, 0);

  LoginTestUtils.clearData();
});
