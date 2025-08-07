/* eslint-disable no-console */

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LoginManagerStorage_json } from "resource://gre/modules/storage-json.sys.mjs";
import { LoginManagerRustStorage } from "resource://gre/modules/storage-rust.sys.mjs";

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

class MirroringObserver {
  #jsonStorage = null;
  #rustStorage = null;

  constructor(jsonStorage, rustStorage) {
    this.#jsonStorage = jsonStorage;
    this.#rustStorage = rustStorage;
  }

  QueryInterface = ChromeUtils.generateQI([
    "nsIObserver",
    "nsISupportsWeakReference",
  ]);

  async observe(subject, _, eventName) {
    switch (eventName) {
      case "addLogin":
        this.log(`rust-mirror: adding login ${subject.guid}...`);
        try {
          recordIncompatibleFormats(subject);

          await this.#rustStorage.addLoginsAsync([subject]);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          console.error("mirror-error:", e);
          recordMigrationFailure("add", e);
        }
        this.log(`rust-mirror: added login ${subject.guid}.`);
        break;

      case "modifyLogin":
        const loginToModify = subject.queryElementAt(0, Ci.nsILoginInfo);
        const newLoginData = subject.queryElementAt(1, Ci.nsILoginInfo);
        this.log(`rust-mirror: modifying login ${loginToModify.guid}...`);
        try {
          recordIncompatibleFormats(subject);

          this.#rustStorage.modifyLogin(loginToModify, newLoginData);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          console.error("mirror-error modifyLogin:", e);
          recordMigrationFailure("modify-login", e);
        }
        this.log(`rust-mirror: modified login ${loginToModify.guid}.`);
        break;

      case "removeLogin":
        this.log(`rust-mirror: removing login ${subject.guid}...`);
        try {
          this.#rustStorage.removeLogin(subject);

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          console.error("mirror-error removeLogin:", e);
          recordMigrationFailure("remove-login", e);
        }
        this.log(`rust-mirror: removed login ${subject.guid}.`);
        break;

      case "removeAllLogins":
        this.log("rust-mirror: removing all logins...");
        try {
          this.#rustStorage.removeAllLogins();

          recordPasswordCountDiff(this.#jsonStorage, this.#rustStorage);
        } catch (e) {
          console.error("mirror-error removeAllLogins:", e);
          recordMigrationFailure("remove-all-logins", e);
        }
        this.log("rust-mirror: removed all logins.");
        break;

      default:
        console.error(
          `mirror-error default: received unhandled event "${eventName}"`
        );
    }
  }
}

ChromeUtils.defineLazyGetter(MirroringObserver.prototype, "log", () => {
  let logger = lazy.LoginHelper.createLogger("Login Mirroring Observer");
  return logger.log.bind(logger);
});

export class LoginManagerStorage extends LoginManagerStorage_json {
  static #jsonStorage = null;
  static #rustStorage = null;
  static #mirroringObserver = null;
  static #logger = lazy.LoginHelper.createLogger("Login Manager Storage");

  static create(callback) {
    const loginsRustMirrorEnabled =
      Services.prefs.getBoolPref("signon.loginsRustMirror.enabled", true) &&
      !lazy.LoginHelper.isPrimaryPasswordSet();

    if (loginsRustMirrorEnabled) {
      LoginManagerStorage.#initializeWithRustMirror(callback);
    } else {
      LoginManagerStorage.#initialize(callback);
    }
    return LoginManagerStorage.#jsonStorage;
  }

  static #initialize(callback) {
    if (LoginManagerStorage.#jsonStorage) {
      return callback?.();
    }

    LoginManagerStorage.#jsonStorage = new LoginManagerStorage_json();

    LoginManagerStorage.#logger.log(
      "initializing LoginManagerStorage without rust mirror"
    );

    return LoginManagerStorage.#jsonStorage
      .initialize()
      .then(() => callback?.());
  }

  static #initializeWithRustMirror(callback) {
    if (LoginManagerStorage.#jsonStorage && LoginManagerStorage.#rustStorage) {
      return callback?.();
    }

    LoginManagerStorage.#jsonStorage = new LoginManagerStorage_json();
    LoginManagerStorage.#rustStorage = new LoginManagerRustStorage();

    LoginManagerStorage.#logger.log(
      "initializing LoginManagerStorage with rust mirror"
    );

    return Promise.all([
      LoginManagerStorage.#jsonStorage.initialize(),
      LoginManagerStorage.#rustStorage.initialize(),
    ])
      .then(async () => {
        try {
          await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
            LoginManagerStorage.#jsonStorage,
            LoginManagerStorage.#rustStorage
          );
        } catch (e) {
          LoginManagerStorage.#logger.error("Login migration failed", e);
          recordMigrationFailure("rolling-migration", e);
        }

        if (this.#mirroringObserver) {
          Services.obs.removeObserver(
            this.#mirroringObserver,
            "passwordmgr-storage-changed"
          );
        }
        this.#mirroringObserver = new MirroringObserver(
          LoginManagerStorage.#jsonStorage,
          LoginManagerStorage.#rustStorage
        );
        Services.obs.addObserver(
          this.#mirroringObserver,
          "passwordmgr-storage-changed"
        );
      })
      .then(() => callback?.());
  }

  static async maybeRunRollingMigrationToRustStorage(jsonStorage, rustStorage) {
    LoginManagerStorage.#logger.log("Running login migration...");

    const jsonChecksum = await jsonStorage.computeShasum();
    const rustCheckpoint = rustStorage.getCheckpoint();

    if (jsonChecksum && jsonChecksum !== rustCheckpoint) {
      LoginManagerStorage.#logger.log(
        "Checksums differ. Rolling migration required."
      );

      rustStorage.removeAllLogins();
      LoginManagerStorage.#logger.log("Cleared existing Rust logins.");

      const logins = await jsonStorage.getAllLogins();

      await rustStorage.addLoginsAsync(logins);
      // TODO: expect result, report errors

      LoginManagerStorage.#logger.log(
        `Successfully migrated ${logins.length} logins.`
      );

      rustStorage.setCheckpoint(jsonChecksum);
      LoginManagerStorage.#logger.log(
        "Migration complete. Checkpoint updated."
      );
      recordPasswordCountDiff(jsonStorage, rustStorage);
    } else {
      LoginManagerStorage.#logger.log("Checksums match. No migration needed.");
    }

    LoginManagerStorage.#logger.log("Login migration finished.");
  }
}
