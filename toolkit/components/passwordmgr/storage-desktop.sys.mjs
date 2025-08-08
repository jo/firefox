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

  static create(callback) {
    Services.prefs.addObserver("signon.loginsRustMirror.enabled", () =>
      this.#maybeInitializeRustMirror()
    );

    if (this.#jsonStorage) {
      callback?.();
      this.#logger.log("json storage already initialized");
      this.#maybeInitializeRustMirror();
    } else {
      this.#jsonStorage = new LoginManagerStorage_json();
      this.#logger.log("initializing json storage");
      this.#jsonStorage.initialize()
        .then(() => this.#maybeInitializeRustMirror())
        .then(() => callback?.());
    }

    return this.#jsonStorage;
  }

  static #maybeInitializeRustMirror() {
    const loginsRustMirrorEnabled =
      Services.prefs.getBoolPref("signon.loginsRustMirror.enabled", true) &&
      !lazy.LoginHelper.isPrimaryPasswordSet();

    if (this.#rustMirror) {
      this.#logger.log("rust mirror already initialized");
      if (!loginsRustMirrorEnabled) {
        this.#logger.log("disabling rust mirror");
        this.#rustMirror.disable();
      }
      return;
    }
    
    if (!this.#jsonStorage) {
      return;
    }

    this.#logger.log("initializing rust mirror");
    this.#rustMirror = new LoginManagerRustMirror(this.#jsonStorage);

    return this.#rustMirror.enable();
  }
}
