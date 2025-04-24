/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LoginManagerStorage_json } from "resource://gre/modules/storage-json.sys.mjs";
import { LoginManagerRustStorage } from "resource://gre/modules/storage-rust.sys.mjs";

export class LoginManagerStorage extends LoginManagerStorage_json {
  static #storage = null;
  static #rustStorage = null;

  static create(callback) {
    if (!LoginManagerStorage.#storage) {
      LoginManagerStorage.#storage = new LoginManagerStorage();
      LoginManagerStorage.#rustStorage = new LoginManagerRustStorage();

      Promise.all([
        LoginManagerStorage.#storage.initialize(),
        LoginManagerStorage.#rustStorage.initialize(),
      ]).then(callback);
    } else if (callback) {
      callback();
    }

    // TODO: switch storage endpoints
    // return LoginManagerStorage.#storage;
    return LoginManagerStorage.#rustStorage;
  }
}
