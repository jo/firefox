// Waits for the primary password prompt, enter primary password and close the
// dialog
async function waitForDialogAndEnterPrimaryPassword(aWindow) {
  const [subject] = await TestUtils.topicObserved("common-dialog-loaded");
  const dialog = subject.Dialog;
  SpecialPowers.wrap(dialog.ui.password1Textbox).setUserInput(
    LoginTestUtils.primaryPassword.primaryPassword
  );
  dialog.ui.button0.click();
  return BrowserTestUtils.waitForEvent(aWindow, "DOMModalDialogClosed");
}

// test that the rust storage receives the primary password entered in js land
add_task(async function test_primary_password_handed_over_to_rust_storage() {
  LoginTestUtils.primaryPassword.enable();

  await BrowserTestUtils.withNewTab(
      {
        gBrowser,
        url: "https://example.com",
      },
      async function (browser) {
        const { LoginManagerRustStorage } = ChromeUtils.importESModule(
          "resource://gre/modules/storage-rust.sys.mjs"
        );

        const rustStorage = new LoginManagerRustStorage();
        await rustStorage.initialize();

        const waitForDialogPromise = waitForDialogAndEnterPrimaryPassword(browser.ownerGlobal);
        LoginTestUtils.primaryPassword.prompt();
        await waitForDialogPromise;

        const loginInfo = LoginTestUtils.testData.formLogin({
          username: "username",
          password: "password",
          guid: "{bb1ac9e6-e539-45d8-9262-854ee4866f49}",
        });
        await rustStorage.addLoginsAsync([loginInfo]);

        // we are able to store a login, so the SDR has been unlocked
        const storedLoginInfo = rustStorage.store.get(loginInfo.guid);
        LoginTestUtils.assertLoginListsEqual(
          [loginInfo],
          [storedLoginInfo]
        );
      }
  )


  LoginTestUtils.primaryPassword.disable();
});
