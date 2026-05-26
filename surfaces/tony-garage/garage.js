(function () {
  var stamp = "20260526-0719";
  var links = document.querySelectorAll("a.new-tab");

  links.forEach(function (link) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");

    var label = link.getAttribute("aria-label") || link.textContent.trim();
    if (!/opens new tab/i.test(label)) {
      link.setAttribute("aria-label", label + " (opens in a new tab)");
    }

    var href = link.getAttribute("href") || "";
    if (href.indexOf("#") === 0 || href.indexOf("http") === 0) {
      return;
    }

    if (href.indexOf("?") === -1) {
      link.setAttribute("href", href + "?v=" + stamp);
    }
  });
}());
