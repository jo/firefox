/* eslint-disable no-console */

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LoginManagerStorage_json } from "resource://gre/modules/storage-json.sys.mjs";
import { LoginManagerRustMirror } from "resource://gre/modules/rust-mirror.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
});

export class LoginManagerStorage extends LoginManagerStorage_json {
  static #jsonStorage = null;
  static #rustMirror = null;
  static #logger = lazy.LoginHelper.createLogger("LoginManagerStorage");
  static #initializationPromise = null;

  static create(callback) {
    Services.prefs.addObserver("signon.loginsRustMirror.enabled", () =>
      this.#maybeInitializeRustMirror()
    );

    if (this.#initializationPromise) {
      this.#logger.log("json storage already initialized");
    } else {
      this.#jsonStorage = new LoginManagerStorage_json();
      this.#logger.log("initializing json storage");
      this.#initializationPromise = new Promise(resolve =>
        this.#jsonStorage.initialize().then(resolve)
      );
    }

    this.#initializationPromise
      .then(() => callback?.())
      .then(() => this.#maybeInitializeRustMirror());

    return this.#jsonStorage;
  }

  /* eslint-disable consistent-return */
  static #maybeInitializeRustMirror() {
    const loginsRustMirrorEnabled =
      Services.prefs.getBoolPref("signon.loginsRustMirror.enabled", true) &&
      !lazy.LoginHelper.isPrimaryPasswordSet();

    if (this.#rustMirror) {
      this.#logger.log("rust mirror already initialized");
      if (loginsRustMirrorEnabled) {
        return this.#rustMirror.enable();
      }
      this.#logger.log("disabling rust mirror");
      return this.#rustMirror.disable();
    }

    if (!this.#jsonStorage) {
      return;
    }

    this.#logger.log("initializing rust mirror");
    this.#rustMirror = new LoginManagerRustMirror(this.#jsonStorage);

    return this.#rustMirror.enable();
  }
}
