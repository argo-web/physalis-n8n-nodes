const { src, dest } = require("gulp");

// Copie les SVG des icônes depuis nodes/ vers dist/nodes/. tsc ne les
// embarque pas → étape gulp dédiée appelée après le build TS.
function buildIcons() {
  return src("nodes/**/*.{png,svg}").pipe(dest("dist/nodes"));
}

exports["build:icons"] = buildIcons;
