/* eslint-disable no-console */

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

 import { LoginManagerStorage_json } from "resource://gre/modules/storage-json.sys.mjs";
 import { LoginManagerRustStorage } from "resource://gre/modules/storage-rust.sys.mjs";
 
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
         console.log(`rust-mirror: adding login ${subject.guid}...`);
         try {
           // TODO: handle incompatibilities:
           // - non-ascii origin
           // - single dot origin
           await this.#rustStorage.addLoginsAsync([subject]);
         } catch (e) {
           console.error("mirror-error:", e);
         }
         console.log(`rust-mirror: added login ${subject.guid}.`);
         break;
 
       case "modifyLogin":
         const loginToModify = subject.queryElementAt(0, Ci.nsILoginInfo);
         const newLoginData = subject.queryElementAt(1, Ci.nsILoginInfo);
         console.log(`rust-mirror: modifing login ${loginToModify.guid}...`);
         try {
           // TODO: handle incompatibilities:
           // - non-ascii origin
           // - single dot origin
           this.#rustStorage.modifyLogin(loginToModify, newLoginData);
         } catch (e) {
           console.error("mirror-error:", e);
         }
         console.log(`rust-mirror: modified login ${loginToModify.guid}.`);
         break;
 
       case "removeLogin":
         console.log(`rust-mirror: removing login ${subject.guid}...`);
         try {
           this.#rustStorage.removeLogin(subject);
         } catch (e) {
           console.error("mirror-error:", e);
         }
         console.log(`rust-mirror: removed login ${subject.guid}.`);
         break;
 
       case "removeAllLogins":
         console.log("rust-mirror: removing all logins...");
         try {
           this.#rustStorage.removeAllLogins();
         } catch (e) {
           console.error("mirror-error:", e);
         }
         console.log("rust-mirror: removed all logins.");
         break;
 
       default:
         console.error(`mirror-error: received unhandled event "${eventName}"`);
     }
   }
 }
 
 export class LoginManagerStorage extends LoginManagerStorage_json {
   static #jsonStorage = null;
   static #rustStorage = null;
   static #initialized = false;
   static #mirroringObserver = null;
 
   static create(callback) {
     if (!LoginManagerStorage.#initialized) {
       LoginManagerStorage.#jsonStorage = new LoginManagerStorage_json();
       LoginManagerStorage.#rustStorage = new LoginManagerRustStorage();
 
       Promise.all([
         LoginManagerStorage.#jsonStorage.initialize(),
         LoginManagerStorage.#rustStorage.initialize(),
       ]).then(async () => {
         try {
           await maybeRunRollingMigrationToRustStorage(
             LoginManagerStorage.#jsonStorage,
             LoginManagerStorage.#rustStorage
           );
         } catch (e) {
           console.error("Login migration failed", e);
         }
 
         LoginManagerStorage.#initialized = true;
 
         callback?.();
       });
     } else if (callback) {
       callback();
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
 
     return LoginManagerStorage.#jsonStorage;
   }
 }
 
 async function maybeRunRollingMigrationToRustStorage(jsonStore, rustStore) {
   console.log("Running login migration...");
 
   const jsonChecksum = await jsonStore._store.computeHexDigest("sha256");
   const rustCheckpoint = rustStore.store.getCheckpoint();
 
   if (jsonChecksum !== rustCheckpoint) {
     console.log("Checksums differ. Rolling migration required.");
 
     rustStore.removeAllLogins();
     console.log("Cleared existing Rust logins.");
 
     const logins = await jsonStore.getAllLogins();
 
     await rustStore.addLoginsAsync(logins);
     console.log(`Successfully migrated ${logins.length} logins.`);
 
     rustStore.store.setCheckpoint(jsonChecksum);
     console.log("Migration complete. Checkpoint updated.");
   } else {
     console.log("Checksums match. No migration needed.");
   }
   console.log("Login migration finished.");
 }
 
 export { maybeRunRollingMigrationToRustStorage };