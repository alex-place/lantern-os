/**
 * Cloud entry point for Railway / any cloud host.
 * Sets PORT so server.js binds to 0.0.0.0 instead of 127.0.0.1.
 * Railway injects PORT automatically; this file just ensures it has a default.
 */
if (!process.env.PORT) process.env.PORT = "4177";
require("./server.js");
