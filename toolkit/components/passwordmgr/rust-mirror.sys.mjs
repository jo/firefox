/* eslint-disable no-console */

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  LoginManagerRustStorage: "resource://gre/modules/storage-rust.sys.mjs",
});

/* Check if an url has punicode encoded hostname */
function isPunycode(origin) {
  try {
    return origin && new URL(origin).hostname.startsWith("xn--");
  } catch (_) {
    return false;
  }
}

function recordPasswordCountDiff(jsonStorage, rustStorage) {
  const jsonCount = jsonStorage.countLogins("", "", "");
  const rustCount = rustStorage.countLogins("", "", "");
  const diff = jsonCount - rustCount;
  Glean.pwmgr.diffSavedPasswordsRust.set(diff);
}

function recordIncompatibleFormats(loginInfo) {
  if (isPunycode(loginInfo.origin)) {
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiOrigin.add();
  }
  if (isPunycode(loginInfo.formActionOrigin)) {
    Glean.pwmgr.rustIncompatibleLoginFormat.nonAsciiFormAction.add();
  }

  if (loginInfo.origin === ".") {
    Glean.pwmgr.rustIncompatibleLoginFormat.dotOrigin.add();
  }
  if (loginInfo.formActionOrigin === ".") {
    Glean.pwmgr.rustIncompatibleLoginFormat.dotFormActionOrigin.add();
  }
}

function recordMigrationFailure(operation, error) {
  Glean.pwmgr.rustMigrationFailure.record({
    operation,
    error_message: error.message ?? String(error),
  });
}

export class LoginManagerRustMirror {
  #logger = null;
  #jsonStorage = null;
  #rustStorage = null;
  #isEnabled = false;

  QueryInterface = ChromeUtils.generateQI([
    "nsIObserver",
    "nsISupportsWeakReference",
  ]);

  constructor(jsonStorage) {
    this.#logger = lazy.LoginHelper.createLogger("LoginManagerRustMirror");
    this.#jsonStorage = jsonStorage;
  }

  async enable() {
    this.#logger.log("Enabling...");
    this.#isEnabled = true;
    Services.obs.addObserver(this, "passwordmgr-storage-changed");
    this.#logger.log("Initializing rust storage");
    this.#rustStorage = new lazy.LoginManagerRustStorage();
    await this.#rustStorage.initialize();
    try {
      await this.maybeRunRollingMigrationToRustStorage();
    } catch (e) {
      this.#logger.error("Login migration failed", e);
      recordMigrationFailure("rolling-migration", e);
    }
    this.#logger.log("Enabled.");
  }

  disable() {
    this.#logger.log("Disabling...");
    this.#isEnabled = false;
    try {
      Services.obs.removeObserver(this, "passwordmgr-storage-changed");
    } catch (e) {
      // this.#logger.error(e);
    }
    this.#rustStorage = null;
    this.#logger.log("Disabled.");
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
          recordIncompatibleFormats(subject);

          await this.#rustStorage.addLoginsAsync([subject]);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          console.error("mirror-error:", e);
          recordMigrationFailure("add", e);
        }
        this.#logger.log(`added login ${subject.guid}.`);
        break;

      case "modifyLogin":
        const loginToModify = subject.queryElementAt(0, Ci.nsILoginInfo);
        const newLoginData = subject.queryElementAt(1, Ci.nsILoginInfo);
        this.#logger.log(`modifying login ${loginToModify.guid}...`);
        try {
          recordIncompatibleFormats(subject);

          this.#rustStorage.modifyLogin(loginToModify, newLoginData);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          console.error("error: modifyLogin:", e);
          recordMigrationFailure("modify-login", e);
        }
        this.#logger.log(`modified login ${loginToModify.guid}.`);
        break;

      case "removeLogin":
        this.#logger.log(`removing login ${subject.guid}...`);
        try {
          this.#rustStorage.removeLogin(subject);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          console.error("error: removeLogin:", e);
          recordMigrationFailure("remove-login", e);
        }
        this.#logger.log(`removed login ${subject.guid}.`);
        break;

      case "removeAllLogins":
        this.#logger.log("removing all logins...");
        try {
          this.#rustStorage.removeAllLogins();

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          console.error("error: removeAllLogins:", e);
          recordMigrationFailure("remove-all-logins", e);
        }
        this.#logger.log("removed all logins.");
        break;

      default:
        console.error(`error: received unhandled event "${eventName}"`);
    }
  }

  async maybeRunRollingMigrationToRustStorage() {
    this.#logger.log("Running login migration...");

    const jsonChecksum = await this.#jsonStorage.computeShasum();
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

    await this.#rustStorage.addLoginsAsync(logins);
    // TODO: expect result, report errors

    this.#logger.log(`Successfully migrated ${logins.length} logins.`);

    this.#rustStorage.setCheckpoint(jsonChecksum);
    this.#logger.log("Migration complete. Checkpoint updated.");
    recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);

    this.#logger.log("Login migration finished.");
  }
}
