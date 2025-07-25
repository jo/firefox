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

class MirroringObserver {
  #rustStorage = null;

  constructor(rustStorage) {
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
          // TODO: handle incompatibilities:
          // - non-ascii origin
          // - single dot origin
          await this.#rustStorage.addLoginsAsync([subject]);
        } catch (e) {
          console.error("mirror-error:", e);
        }
        this.log(`rust-mirror: added login ${subject.guid}.`);
        break;

      case "modifyLogin":
        const loginToModify = subject.queryElementAt(0, Ci.nsILoginInfo);
        const newLoginData = subject.queryElementAt(1, Ci.nsILoginInfo);
        this.log(`rust-mirror: modifying login ${loginToModify.guid}...`);
        try {
          // TODO: handle incompatibilities:
          // - non-ascii origin
          // - single dot origin
          this.#rustStorage.modifyLogin(loginToModify, newLoginData);
        } catch (e) {
          console.error("mirror-error:", e);
        }
        this.log(`rust-mirror: modified login ${loginToModify.guid}.`);
        break;

      case "removeLogin":
        this.log(`rust-mirror: removing login ${subject.guid}...`);
        try {
          this.#rustStorage.removeLogin(subject);
        } catch (e) {
          console.error("mirror-error:", e);
        }
        this.log(`rust-mirror: removed login ${subject.guid}.`);
        break;

      case "removeAllLogins":
        this.log("rust-mirror: removing all logins...");
        try {
          this.#rustStorage.removeAllLogins();
        } catch (e) {
          console.error("mirror-error:", e);
        }
        this.log("rust-mirror: removed all logins.");
        break;

      default:
        console.error(`mirror-error: received unhandled event "${eventName}"`);
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
  static #initialized = false;
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
    if (LoginManagerStorage.#initialized) {
      return callback?.();
    }

    LoginManagerStorage.#jsonStorage = new LoginManagerStorage_json();

    return LoginManagerStorage.#jsonStorage
      .initialize()
      .then(() => {
        LoginManagerStorage.#initialized = true;
      })
      .then(() => callback?.());
  }

  static #initializeWithRustMirror(callback) {
    if (LoginManagerStorage.#initialized) {
      return callback?.();
    }

    LoginManagerStorage.#jsonStorage = new LoginManagerStorage_json();
    LoginManagerStorage.#rustStorage = new LoginManagerRustStorage();

    return Promise.all([
      LoginManagerStorage.#jsonStorage.initialize(),
      LoginManagerStorage.#rustStorage.initialize(),
    ])
      .then(async () => {
        LoginManagerStorage.#logger.log(
          "Oh jeay, I have initialized both stores"
        );
        try {
          await LoginManagerStorage.maybeRunRollingMigrationToRustStorage(
            LoginManagerStorage.#jsonStorage,
            LoginManagerStorage.#rustStorage
          );
        } catch (e) {
          LoginManagerStorage.#logger.error("Login migration failed", e);
        }

        if (this.#mirroringObserver) {
          Services.obs.removeObserver(
            this.#mirroringObserver,
            "passwordmgr-storage-changed"
          );
        }
        this.#mirroringObserver = new MirroringObserver(
          LoginManagerStorage.#rustStorage
        );
        Services.obs.addObserver(
          this.#mirroringObserver,
          "passwordmgr-storage-changed"
        );

        LoginManagerStorage.#initialized = true;
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
      LoginManagerStorage.#logger.log(
        `Successfully migrated ${logins.length} logins.`
      );

      rustStorage.setCheckpoint(jsonChecksum);
      LoginManagerStorage.#logger.log(
        "Migration complete. Checkpoint updated."
      );
    } else {
      LoginManagerStorage.#logger.log("Checksums match. No migration needed.");
    }

    LoginManagerStorage.#logger.log("Login migration finished.");
  }
}
