/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
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
      recordMigrationFailure("rolling-migration", e);
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
      this.#logger.log("Mirror is not active. Change will not be mirrored.");
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
          this.#logger.error("mirror-error:", e);
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
          this.#logger.error("error: modifyLogin:", e);
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
          this.#logger.error("error: removeLogin:", e);
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
          this.#logger.error("error: removeAllLogins:", e);
          recordMigrationFailure("remove-all-logins", e);
        }
        this.#logger.log("removed all logins.");
        break;

      default:
        this.#logger.error(`error: received unhandled event "${eventName}"`);
    }
  }

  async maybeRunRollingMigrationToRustStorage() {
    this.#logger.log("Checking whether migration is needed.");

    // eg in case a primary password has been set after enabling
    if (!this.#isActive) {
      this.#logger.log("Mirror is not active. No migration needed..");
      return;
    }

    // wait until loaded
    await this.#jsonStorage.initializationPromise;

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

    const results = await this.#rustStorage.addLoginsAsync(logins, true);
    for (const { error } of results) {
      if (error) {
        this.#logger.error("error during rolling migration:", error);
        recordMigrationFailure("add", error);
      }
    }

    this.#logger.log(`Successfully migrated ${logins.length} logins.`);

    this.#rustStorage.setCheckpoint(jsonChecksum);
    this.#logger.log("Migration complete. Checkpoint updated.");
    recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);

    this.#logger.log("Login migration finished.");
  }
}
