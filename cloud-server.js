/**
 * Cloud entry point for any cloud host (GCE today).
 * Sets PORT so server.js binds to 0.0.0.0 instead of 127.0.0.1.
 * The host injects PORT; this file just ensures it has a default.
 */
if (!process.env.PORT) process.env.PORT = "4177";
require("./server.js");
