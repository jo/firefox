/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
});

export class LoginManagerRustMirror {
  #logger = null;
  #jsonStorage = null;
  #rustStorage = null;
  #isEnabled = false;

  QueryInterface = ChromeUtils.generateQI([
    "nsIObserver",
    "nsISupportsWeakReference",
  ]);

  constructor(jsonStorage, rustStorage) {
    this.#logger = lazy.LoginHelper.createLogger("LoginManagerRustMirror");
    this.#jsonStorage = jsonStorage;
    this.#rustStorage = rustStorage;
  }

  async enable() {
    this.#isEnabled = true;
    try {
      await this.maybeRunRollingMigrationToRustStorage();
    } catch (e) {
      this.#logger.error("Login migration failed", e);
    }
  }

  disable() {
    this.#isEnabled = false;
  }

  get #isActive() {
    return this.#isEnabled && !lazy.LoginHelper.isPrimaryPasswordSet();
  }

  // nsIObserver
  async observe(subject, _, eventName) {
    this.#logger.log(`received change event ${eventName}...`);

    // eg in case a primary password has been set after enabling
    if (!this.#isActive) {
      return;
    }

    switch (eventName) {
      case "addLogin":
        this.#logger.log(`adding login ${subject.guid}...`);
        try {
          await this.#rustStorage.addLoginsAsync([subject]);
        } catch (e) {
          this.#logger.error("mirror-error:", e);
        }
        this.#logger.log(`added login ${subject.guid}.`);
        break;

      case "modifyLogin":
        const loginToModify = subject.queryElementAt(0, Ci.nsILoginInfo);
        const newLoginData = subject.queryElementAt(1, Ci.nsILoginInfo);
        this.#logger.log(`modifying login ${loginToModify.guid}...`);
        try {
          this.#rustStorage.modifyLogin(loginToModify, newLoginData);
        } catch (e) {
          this.#logger.error("error: modifyLogin:", e);
        }
        this.#logger.log(`modified login ${loginToModify.guid}.`);
        break;

      case "removeLogin":
        this.#logger.log(`removing login ${subject.guid}...`);
        try {
          this.#rustStorage.removeLogin(subject);
        } catch (e) {
          this.#logger.error("error: removeLogin:", e);
        }
        this.#logger.log(`removed login ${subject.guid}.`);
        break;

      case "removeAllLogins":
        this.#logger.log("removing all logins...");
        try {
          this.#rustStorage.removeAllLogins();
        } catch (e) {
          this.#logger.error("error: removeAllLogins:", e);
        }
        this.#logger.log("removed all logins.");
        break;

      default:
        this.#logger.error(`error: received unhandled event "${eventName}"`);
    }
  }

  async maybeRunRollingMigrationToRustStorage() {
    // eg in case a primary password has been set after enabling
    if (!this.#isActive) {
      return;
    }

    // wait until loaded
    await this.#jsonStorage.initializationPromise;
    this.#logger.log("Running login migration...");

    const jsonChecksum = await this.#jsonStorage.computeSha256();
    const rustCheckpoint = this.#rustStorage.getCheckpoint();

    if (!jsonChecksum) {
      this.#logger.log("Empty json store. No migration needed.");
      return;
    }

    if (jsonChecksum === rustCheckpoint) {
      this.#logger.log("Checksums match. No migration needed.");
      return;
    }

    this.#logger.log("Checksums differ. Rolling migration required.");

    this.#rustStorage.removeAllLogins();
    this.#logger.log("Cleared existing Rust logins.");

    const logins = await this.#jsonStorage.getAllLogins();

    await this.#rustStorage.addLoginsAsync(logins, true);
    // const batchSize = 300;
    // for (let i = 0; i < logins.length; i += batchSize) {
    //   const batch = logins.slice(i, i + batchSize);

    //   await this.#rustStorage.addLoginsAsync(batch, true);
    // }

    this.#logger.log(`Successfully migrated ${logins.length} logins.`);

    this.#rustStorage.setCheckpoint(jsonChecksum);
    this.#logger.log("Migration complete. Checkpoint updated.");

    this.#logger.log("Login migration finished.");
  }
}
