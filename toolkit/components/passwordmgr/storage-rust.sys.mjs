/* eslint-disable no-console */

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * LoginManagerStorage implementation for the Rust logins storage back-end.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FXA_PWDMGR_HOST: "resource://gre/modules/FxAccountsCommon.sys.mjs",
  FXA_PWDMGR_REALM: "resource://gre/modules/FxAccountsCommon.sys.mjs",

  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",

  // how can we group this, without repeating the source?
  LoginEntry:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustLogins.sys.mjs",
  LoginMeta:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustLogins.sys.mjs",
  LoginEntryWithMeta:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustLogins.sys.mjs",
  createLoginStoreWithStaticKeyManager:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustLogins.sys.mjs",
});

const { initialize: initRustComponents } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustInitRustComponents.sys.mjs"
);

const LoginInfo = Components.Constructor(
  "@mozilla.org/login-manager/loginInfo;1",
  "nsILoginInfo",
  "init"
);

// Convert a LoginInfo, as known to the JS world, to a LoginEntry, the Rust
// Login type.
// This could be an instance method implemented in
// toolkit/components/passwordmgr/LoginInfo.sys.mjs
// but I'd like to decouple from as many components as possible by now
const loginInfoToLoginEntry = loginInfo =>
  new lazy.LoginEntry({
    origin: loginInfo.origin,
    httpRealm: loginInfo.httpRealm,
    formActionOrigin: loginInfo.formActionOrigin,
    usernameField: loginInfo.usernameField,
    passwordField: loginInfo.passwordField,
    username: loginInfo.username,
    password: loginInfo.password,
  });

// Convert a LoginInfo to a LoginEntryWithMeta, to be used for migrating
// records between legacy and Rust storage.
const loginInfoToLoginEntryWithMeta = loginInfo =>
  new lazy.LoginEntryWithMeta({
    entry: loginInfoToLoginEntry(loginInfo),
    meta: new lazy.LoginMeta({
      id: loginInfo.guid,
      timesUsed: loginInfo.timesUsed,
      timeCreated: loginInfo.timeCreated,
      timeLastUsed: loginInfo.timeLastUsed,
      timePasswordChanged: loginInfo.timePasswordChanged,
    }),
  });

// Convert a Login instance, as returned from Rust Logins, to a LoginInfo
const loginToLoginInfo = login => {
  const loginInfo = new LoginInfo(
    login.origin,
    login.formActionOrigin,
    login.httpRealm,
    login.username,
    login.password,
    login.usernameField,
    login.passwordField
  );

  // add meta information
  loginInfo.QueryInterface(Ci.nsILoginMetaInfo);
  // Rust Login ids are guids
  loginInfo.guid = login.id;
  loginInfo.timeCreated = login.timeCreated;
  loginInfo.timeLastUsed = login.timeLastUsed;
  loginInfo.timePasswordChanged = login.timePasswordChanged;
  loginInfo.timesUsed = login.timesUsed;

  /* These fields are not attributes on the Rust Login class
  loginInfo.syncCounter = login.syncCounter;
  loginInfo.everSynced = login.everSynced;
  loginInfo.unknownFields = login.encryptedUnknownFields;
  */

  return loginInfo;
};

// An adapter which talks to the Rust Logins Store via LoginInfo objects
class RustLoginsStoreAdapter {
  #store = null;

  constructor(store) {
    this.#store = store;
  }

  get(id) {
    const login = this.#store.get(id);
    return login && loginToLoginInfo(login);
  }

  list() {
    const logins = this.#store.list();
    return logins.map(loginToLoginInfo);
  }

  update(id, loginInfo) {
    const loginEntry = loginInfoToLoginEntry(loginInfo);
    const login = this.#store.update(id, loginEntry);
    return loginToLoginInfo(login);
  }

  add(loginInfo) {
    const loginEntry = loginInfoToLoginEntry(loginInfo);
    const login = this.#store.add(loginEntry);
    return loginToLoginInfo(login);
  }

  addWithMeta(loginInfo) {
    const loginEntryWithMeta = loginInfoToLoginEntryWithMeta(loginInfo);
    const login = this.#store.addWithMeta(loginEntryWithMeta);
    return loginToLoginInfo(login);
  }

  addManyWithMeta(loginInfos) {
    const loginEntriesWithMeta = loginInfos.map(loginInfoToLoginEntryWithMeta);
    const results = this.#store.addManyWithMeta(loginEntriesWithMeta);
    return results
      .filter(result => "login" in result)
      .map(({ login }) => loginToLoginInfo(login));
  }

  delete(id) {
    return this.#store.delete(id);
  }

  deleteMany(ids) {
    return this.#store.deleteMany(ids);
  }

  // reset() {
  //   return this.#store.reset()
  // }

  wipeLocal() {
    return this.#store.wipeLocal();
  }

  touch(id) {
    this.#store.touch(id);
  }

  findLoginToUpdate(loginInfo) {
    const loginEntry = loginInfoToLoginEntry(loginInfo);
    const login = this.#store.findLoginToUpdate(loginEntry);
    return login && loginToLoginInfo(login);
  }

  getCheckpoint() {
    return this.#store.getCheckpoint();
  }

  setCheckpoint(checkpoint) {
    return this.#store.setCheckpoint(checkpoint);
  }
}

export class LoginManagerRustStorage {
  #storageAdapter = null;

  initialize() {
    try {
      const profilePath = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
      const path = `${profilePath}/logins.db`;

      return (async () => {
        this.log(`Initializing Rust login storage at ${path}`);
  
        await initRustComponents(profilePath);

        // using a static, predefined key for development
        const key =
          '{\"kty\":\"oct\",\"k\":\"0YqHUnEcQEMLEs7ftX1j0TMJ80876EqnKNSTx1YYnzM\"}';
        this.log(`using key: ${key}`);

        const store = lazy.createLoginStoreWithStaticKeyManager(path, key);
        this.#storageAdapter = new RustLoginsStoreAdapter(store);
        this.log("Rust login storage ready.");
      })().catch(console.error);
    } catch (e) {
      this.log(`Initialization failed ${e.name}.`);
      throw new Error("Initialization failed");
    }
  }

  /**
   * Internal method used by regression tests only.  It is called before
   * replacing this storage module with a new instance.
   */
  terminate() {
    // TODO: a noop by now
    // throw Components.Exception("terminate", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  /**
   * Returns the "sync id" used by Sync to know whether the store is current with
   * respect to the sync servers. It is stored encrypted, but only so we
   * can detect failure to decrypt (for example, a "reset" of the primary
   * password will leave all logins alone, but they will fail to decrypt. We
   * also want this metadata to be unavailable in that scenario)
   *
   * Returns null if the data doesn't exist or if the data can't be
   * decrypted (including if the primary-password prompt is cancelled). This is
   * OK for Sync as it can't even begin syncing if the primary-password is
   * locked as the sync encrytion keys are stored in this login manager.
   */
  async getSyncID() {
    throw Components.Exception("getSyncID", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  async setSyncID(syncID) {
    throw Components.Exception("setSyncID", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  async getLastSync() {
    throw Components.Exception("getLastSync", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  async setLastSync(timestamp) {
    throw Components.Exception("setLastSync", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  async resetSyncCounter(guid, value) {
    throw Components.Exception("resetSyncCounter", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  // Returns false if the login has marked as deleted or doesn't exist.
  loginIsDeleted(guid) {
    throw Components.Exception("loginIsDeleted", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  addWithMeta(login) {
    return this.#storageAdapter.addWithMeta(login);
  }

  async addLoginsAsync(logins, continueOnDuplicates = false) {
    if (logins.length === 0) {
      return logins;
    }

    // TODO: ignoring continueOnDuplicates for now
    const loginsToAdd = [];
    for (const loginInfo of logins) {
      // check for duplicates
      const loginData = {
        origin: loginInfo.origin,
        formActionOrigin: loginInfo.formActionOrigin,
        httpRealm: loginInfo.httpRealm,
      };
      const existingLogins = await this.searchLoginsAsync(loginData);

      const matchingLogin = existingLogins.find(l =>
        loginInfo.matches(l, true)
      );
      if (matchingLogin) {
        if (continueOnDuplicates) {
          continue;
        } else {
          throw lazy.LoginHelper.createLoginAlreadyExistsError(
            matchingLogin.guid
          );
        }
      }

      loginsToAdd.push(loginInfo);
    }

    const result = this.#storageAdapter.addManyWithMeta(loginsToAdd);

    // TODO: during write-only replica these events are disabled
    // Send a notification that a login was added.
    // lazy.LoginHelper.notifyStorageChanged("addLogin", resultLoginInfo);

    // Emulate being async
    return Promise.resolve(result);
  }

  modifyLogin(oldLogin, newLoginData, fromSync) {
    const oldStoredLogin = this.#storageAdapter.findLoginToUpdate(oldLogin);

    if (!oldStoredLogin) {
      throw new Error("No matching logins");
    }

    const idToModify = oldStoredLogin.guid;

    const newLogin = lazy.LoginHelper.buildModifiedLogin(
      oldStoredLogin,
      newLoginData
    );

    // TODO
    // // Check if the new GUID is duplicate.
    // if (
    //   newLogin.guid != oldStoredLogin.guid &&
    //   !this._isGuidUnique(newLogin.guid)
    // ) {
    //   throw new Error("specified GUID already exists");
    // }

    // Look for an existing entry in case key properties changed.
    if (!newLogin.matches(oldLogin, true)) {
      const loginData = {
        origin: newLogin.origin,
        formActionOrigin: newLogin.formActionOrigin,
        httpRealm: newLogin.httpRealm,
      };

      const logins = this.searchLogins(
        lazy.LoginHelper.newPropertyBag(loginData)
      );

      const matchingLogin = logins.find(login => newLogin.matches(login, true));
      if (matchingLogin) {
        throw lazy.LoginHelper.createLoginAlreadyExistsError(
          matchingLogin.guid
        );
      }
    }

    // TODO
    // // Don't sync changes to the accounts password or when changes were only
    // // made to fields that should not be synced.
    // if (
    //   !fromSync &&
    //   login.hostname != lazy.FXA_PWDMGR_HOST &&
    //   isSyncableChange(oldLogin, newLogin)
    // ) {
    //   // this.#incrementSyncCounter(newLogin);
    // }

    this.#storageAdapter.update(idToModify, newLogin);

    // TODO: during write-only replica these events are disabled
    // lazy.LoginHelper.notifyStorageChanged("modifyLogin", [
    //   oldStoredLogin,
    //   newLogin,
    // ]);
  }

  recordPasswordUse(login) {
    const oldStoredLogin = this.#storageAdapter.findLoginToUpdate(login);

    if (!oldStoredLogin) {
      throw new Error("No matching logins");
    }

    this.#storageAdapter.touch(oldStoredLogin.guid);
  }

  async recordBreachAlertDismissal(loginGUID) {
    throw Components.Exception(
      "recordBreachAlertDismissal",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }

  getBreachAlertDismissalsByLoginGUID() {
    // throw Components.Exception("getBreachAlertDismissalsByLoginGUID", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  /**
   * Returns an array of nsILoginInfo. If decryption of a login
   * fails due to a corrupt entry, the login is not included in
   * the resulting array.
   *
   * @resolve {nsILoginInfo[]}
   */
  async getAllLogins(includeDeleted) {
    // TODO: `includeDeleted` is unsupported
    if (includeDeleted) {
      throw Components.Exception(
        "getAllLogins with includeDeleted",
        Cr.NS_ERROR_NOT_IMPLEMENTED
      );
    }
    return Promise.resolve(this.#storageAdapter.list());
  }

  // The Rust API is sync atm
  searchLoginsAsync(matchData, includeDeleted) {
    this.log(`Searching for matching logins for origin ${matchData.origin}.`);
    const result = this.searchLogins(
      lazy.LoginHelper.newPropertyBag(matchData),
      includeDeleted
    );

    // Emulate being async:
    return Promise.resolve(result);
  }

  /**
   * Public wrapper around #searchLogins to convert the nsIPropertyBag to a
   * JavaScript object and decrypt the results.
   *
   * @return {nsILoginInfo[]} which are decrypted.
   */
  searchLogins(matchData, includeDeleted) {
    const realMatchData = {};
    const options = {};
    matchData.QueryInterface(Ci.nsIPropertyBag2);

    if (matchData.hasKey("guid")) {
      realMatchData.guid = matchData.getProperty("guid");
    } else {
      for (const prop of matchData.enumerator) {
        switch (prop.name) {
          // Some property names aren't field names but are special options to
          // affect the search.
          case "acceptDifferentSubdomains":
          case "schemeUpgrades":
          case "acceptRelatedRealms":
          case "relatedRealms": {
            options[prop.name] = prop.value;
            break;
          }
          default: {
            realMatchData[prop.name] = prop.value;
            break;
          }
        }
      }
    }
    const [logins] = this.#searchLogins(realMatchData, includeDeleted, options);
    return logins;
  }

  #searchLogins(
    matchData,
    includeDeleted = false,
    aOptions = {
      schemeUpgrades: false,
      acceptDifferentSubdomains: false,
      acceptRelatedRealms: false,
      relatedRealms: [],
    },
    candidateLogins = this.#storageAdapter.list()
  ) {
    function match(aLoginItem) {
      for (const field in matchData) {
        const wantedValue = matchData[field];

        // Override the storage field name for some fields due to backwards
        // compatibility with Sync/storage.
        let storageFieldName = field;
        switch (field) {
          case "formActionOrigin": {
            storageFieldName = "formSubmitURL";
            break;
          }
          case "origin": {
            storageFieldName = "hostname";
            break;
          }
        }

        switch (field) {
          case "formActionOrigin":
            if (wantedValue != null) {
              // Historical compatibility requires this special case
              if (
                aLoginItem.formSubmitURL == "" ||
                (wantedValue == "" && Object.keys(matchData).length != 1)
              ) {
                break;
              }
              if (
                !lazy.LoginHelper.isOriginMatching(
                  aLoginItem[storageFieldName],
                  wantedValue,
                  aOptions
                )
              ) {
                return false;
              }
              break;
            }
          // fall through
          case "origin":
            if (wantedValue != null) {
              // needed for formActionOrigin fall through
              if (
                !lazy.LoginHelper.isOriginMatching(
                  aLoginItem[storageFieldName],
                  wantedValue,
                  aOptions
                )
              ) {
                return false;
              }
              break;
            }
          // Normal cases.
          // fall through
          case "httpRealm":
          case "id":
          case "usernameField":
          case "passwordField":
          case "encryptedUsername":
          case "encryptedPassword":
          case "guid":
          case "encType":
          case "timeCreated":
          case "timeLastUsed":
          case "timePasswordChanged":
          case "timesUsed":
          case "syncCounter":
          case "everSynced":
            if (wantedValue == null && aLoginItem[storageFieldName]) {
              return false;
            } else if (aLoginItem[storageFieldName] != wantedValue) {
              return false;
            }
            break;
          // Fail if caller requests an unknown property.
          default:
            throw new Error("Unexpected field: " + field);
        }
      }
      return true;
    }

    const foundLogins = [];
    const foundIds = [];

    for (const login of candidateLogins) {
      if (login.deleted && !includeDeleted) {
        continue; // skip deleted items
      }

      if (match(login)) {
        foundLogins.push(login);
        foundIds.push(login.guid);
      }
    }

    this.log(
      `Returning ${foundLogins.length} logins for specified origin with options ${aOptions}`
    );
    return [foundLogins, foundIds];
  }

  removeLogin(login, fromSync) {
    const storedLogin = this.#storageAdapter.findLoginToUpdate(login);

    if (!storedLogin) {
      throw new Error("No matching logins");
    }

    const idToDelete = storedLogin.guid;

    this.#storageAdapter.delete(idToDelete);

    Glean.pwmgr.numSavedPasswords.set(this.countLogins("", "", ""));
    // TODO: during write-only replica these events are disabled
    // lazy.LoginHelper.notifyStorageChanged("removeLogin", storedLogin);
  }

  /**
   * Removes all logins from local storage, including FxA Sync key.
   *
   * NOTE: You probably want removeAllUserFacingLogins instead of this function.
   *
   */
  removeAllLogins() {
    this.#removeLogins(false, true);
  }

  /**
   * Removes all user facing logins from storage. e.g. all logins except the FxA Sync key
   *
   * If you need to remove the FxA key, use `removeAllLogins` instead
   *
   * @param fullyRemove remove the logins rather than mark them deleted.
   */
  removeAllUserFacingLogins(fullyRemove) {
    this.#removeLogins(fullyRemove, false);
  }

  /**
   * Removes all logins from storage. If removeFXALogin is true, then the FxA Sync
   * key is also removed.
   *
   * @param fullyRemove remove the logins rather than mark them deleted.
   * @param removeFXALogin also remove the FxA Sync key.
   */
  #removeLogins(fullyRemove, removeFXALogin = false) {
    this.log("Removing all logins.");

    const removedLogins = [];
    const remainingLogins = [];

    const logins = this.#storageAdapter.list();
    const idsToDelete = [];
    for (const login of logins) {
      if (
        !removeFXALogin &&
        login.hostname == lazy.FXA_PWDMGR_HOST &&
        login.httpRealm == lazy.FXA_PWDMGR_REALM
      ) {
        remainingLogins.push(login);
      } else {
        removedLogins.push(login);

        idsToDelete.push(login.guid);

        // TODO: unsupported case:
        // if (!fullyRemove && login?.everSynced) {
        //   // The login has been synced, so mark it as deleted.
        //   this.#incrementSyncCounter(login);
        //   this.#replaceLoginWithTombstone(login);
        //   remainingLogins.push(login);
        // }
      }
    }

    this.#storageAdapter.deleteMany(idsToDelete);

    // TODO: this is the place to update these in memory stores
    // this._store.data.potentiallyVulnerablePasswords = [];
    // this._store.data.dismissedBreachAlertsByLoginGUID = {};

    // TODO: during write-only replica these events are disabled
    // lazy.LoginHelper.notifyStorageChanged("removeAllLogins", removedLogins);
  }

  findLogins(origin, formActionOrigin, httpRealm) {
    const loginData = {
      origin,
      formActionOrigin,
      httpRealm,
    };
    const matchData = {};
    for (const field of ["origin", "formActionOrigin", "httpRealm"]) {
      if (loginData[field] != "") {
        matchData[field] = loginData[field];
      }
    }
    const [logins] = this.#searchLogins(matchData);

    this.log(`Returning ${logins.length} logins.`);
    return logins;
  }

  countLogins(origin, formActionOrigin, httpRealm) {
    const loginData = {
      origin,
      formActionOrigin,
      httpRealm,
    };

    const matchData = {};
    for (const field of ["origin", "formActionOrigin", "httpRealm"]) {
      if (loginData[field] != "") {
        matchData[field] = loginData[field];
      }
    }
    const [logins] = this.#searchLogins(matchData);

    this.log(`Counted ${logins.length} logins.`);
    return logins.length;
  }

  addPotentiallyVulnerablePassword(login) {
    throw Components.Exception(
      "addPotentiallyVulnerablePassword",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }

  isPotentiallyVulnerablePassword(login) {
    throw Components.Exception(
      "isPotentiallyVulnerablePassword",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }

  clearAllPotentiallyVulnerablePasswords() {
    throw Components.Exception(
      "clearAllPotentiallyVulnerablePasswords",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }

  get uiBusy() {
    throw Components.Exception("uiBusy", Cr.NS_ERROR_NOT_IMPLEMENTED);
  }

  get isLoggedIn() {
    throw Components.Exception("isLoggedIn", Cr.NS_ERROR_NOT_IMPLEMENTED);
  
  }

  // Retrieve checkpoint from Rust's meta storage, used for rolling migration.
  getCheckpoint() {
    return this.#storageAdapter.getCheckpoint();
  }

  // Store checkpoint in Rust's meta storage, used for rolling migration.
  setCheckpoint(checkpoint) {
    return this.#storageAdapter.setCheckpoint(checkpoint);
  }
}

ChromeUtils.defineLazyGetter(LoginManagerRustStorage.prototype, "log", () => {
  const logger = lazy.LoginHelper.createLogger("RustLogins");
  return logger.log.bind(logger);
});
