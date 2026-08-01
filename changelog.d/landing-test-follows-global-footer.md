fix(tests): the landing-page assertions follow the footer into the shared chrome

#3146 made the footer global (js/site-chrome.js) and removed it from index.html, so
two python assertions that looked for the GitHub link and the /api/health probe in
the landing markup started failing on master. They now assert against the shared
chrome, where those markers actually live.
