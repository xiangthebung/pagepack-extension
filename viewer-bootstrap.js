(function () {
  function showBootstrapError(error) {
    const loading = document.getElementById("reader-loading");
    const main = document.getElementById("reader-main");
    const box = document.getElementById("reader-error");
    const text = document.getElementById("reader-error-text");
    if (loading) loading.hidden = true;
    if (main) main.hidden = true;
    if (box) box.hidden = false;
    if (text) text.textContent = error?.message || String(error || "The reader failed to start.");
  }
  window.PagePackViewer = { showError: showBootstrapError };
  import("./viewer.js").catch(showBootstrapError);
}());
