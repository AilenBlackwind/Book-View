const fs = require("fs");
const path = require("path");

const files = ["main.js", "styles.css", "manifest.json"];
const dest = path.resolve(__dirname, "..", "..", "..", "..", "MainVault", ".obsidian", "plugins", "Book-View");

for (const f of files) {
  const src = path.join(__dirname, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dest, f));
    console.log("Copied " + f);
  } else {
    console.warn("Skipped " + f + " (not found)");
  }
}
