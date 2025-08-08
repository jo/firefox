/* eslint-disable no-console */

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LoginManagerStorage_json } from "resource://gre/modules/storage-json.sys.mjs";
import { LoginManagerRustStorage } from "resource://gre/modules/storage-rust.sys.mjs";
import { LoginManagerRustMirror } from "resource://gre/modules/rust-mirror.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
});

export class LoginManagerStorage extends LoginManagerStorage_json {
  static #jsonStorage = null;
  static #rustStorage = null;
  static #rustMirror = null;
  static #logger = lazy.LoginHelper.createLogger("LoginManagerStorage");
  static #initializationPromise = null;

  static create(callback) {
    Services.prefs.addObserver("signon.loginsRustMirror.enabled", () =>
      this.#maybeEnableRustMirror()
    );

    if (this.#initializationPromise) {
      this.#logger.log("json storage already initialized");
    } else {
      this.#jsonStorage = new LoginManagerStorage_json();
      this.#rustStorage = new LoginManagerRustStorage();
      this.#rustMirror = new LoginManagerRustMirror(
        this.#jsonStorage,
        this.#rustStorage
      );

      Services.obs.addObserver(this.#rustMirror, "passwordmgr-storage-changed");

      this.#initializationPromise = new Promise(resolve =>
        this.#jsonStorage
          .initialize()
          .then(() => this.#rustStorage.initialize())
          .then(resolve)
      );
    }

    this.#initializationPromise
      .then(() => callback?.())
      .then(() => this.#maybeEnableRustMirror());

    return this.#jsonStorage;
  }

  static #maybeEnableRustMirror() {
    const loginsRustMirrorEnabled =
      Services.prefs.getBoolPref("signon.loginsRustMirror.enabled", true) &&
      !lazy.LoginHelper.isPrimaryPasswordSet();

    this.#logger.log(
      loginsRustMirrorEnabled ? "enabling rust mirror" : "disabling rust mirror"
    );
    return loginsRustMirrorEnabled
      ? this.#rustMirror.enable()
      : this.#rustMirror.disable();
  }
}
