'use strict';
// No API/IPC, input or clipboard access is exposed to the remote page. This
// dedicated background page does not checkpoint over the user's active tab.
// Persistent Cookie/localStorage/IndexedDB auth is owned by the original Session.
