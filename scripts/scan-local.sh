#!/usr/bin/env bash
#
# Rejoue LOCALEMENT le scan de verification n8n, avant de publier.
#
# Pourquoi ce script existe
# -------------------------
# `npx @n8n/scan-community-package` n'accepte qu'un nom de paquet DEJA PUBLIE :
# il interroge le registre, verifie la provenance, puis lint. Il n'y a donc
# aucun moyen officiel de savoir si un paquet passera avant de bruler un numero
# de version -- et les metadonnees npm etant immuables, un refus coute une
# version entiere. Les 1.0.0, 1.0.1 et 1.0.2 sont parties comme ca.
#
# Le scanner exporte `analyzePackage`, ce qui permet de rejouer exactement ses
# deux branches de lint sur des sources locales. La provenance, elle, n'est pas
# rejouable ici : elle ne peut venir que d'un run GitHub Actions.
#
# Ce que ce script ne couvre PAS : la provenance, et la verification que le
# commit attesté est bien celui qu'on a sous la main.
#
# Trois pieges, tous decouverts a la dure
# ---------------------------------------
# 1. Les deux branches n'ont PAS le meme perimetre. La branche « source » lint
#    `package.json` + `{nodes,credentials}/**` ; la branche « dist » lint tous
#    les `.js` du tarball. Lancer le lint sur le dossier entier fait remonter
#    `gulpfile.js` comme dependance interdite : un faux positif.
#
# 2. ⚠️ **La PROFONDEUR du chemin change le resultat.** `findPackageJson` du
#    plugin remonte les dossiers tant que `dirname(d) !== root`, donc il
#    n'atteint JAMAIS un `package.json` situe a un seul niveau sous la racine.
#    Monte en `/src`, le paquet passe pour depourvu de credentials declarees et
#    `no-credential-reuse` accuse le noeud de reutiliser la credential d'un
#    autre paquet. Un montage profond fait disparaitre l'erreur. D'ou
#    `/work/checkout/src` ci-dessous, et surtout : ne pas « simplifier » ces
#    chemins.
#
# 3. Le scanner lint avec `allowInlineConfig: false`. Les `eslint-disable` de
#    la source sont IGNORES -- ce que le `npm run lint` du projet, lui, honore.
#    Un lint local vert ne dit donc rien du scanner.
#
# Node 22 en conteneur parce que `isolated-vm`, dependance du scanner, ne
# compile pas sur les Node recents du poste.
#
# Usage : ./scripts/scan-local.sh
# Sortie : VERDICT PASS/FAIL, et le detail des violations.

set -euo pipefail

cd "$(dirname "$0")/.."
racine=$(pwd)
travail=$(mktemp -d)
trap 'rm -rf "$travail"' EXIT

echo "→ Export de HEAD (c'est ce que le scanner recupere via la provenance)"
mkdir -p "$travail/srcleg"
git archive HEAD | tar -x -C "$travail/srcleg"

echo "→ Construction du tarball publie"
npm run build >/dev/null
tarball=$(npm pack --silent --pack-destination "$travail")
mkdir -p "$travail/distleg"
tar -xzf "$travail/$tarball" -C "$travail/distleg"

echo "→ Scan (premiere execution : quelques minutes d'installation)"
docker run --rm \
  -v "$travail/srcleg":/work/checkout/src \
  -v "$travail/distleg/package":/work/tarball/pkg \
  node:22 sh -c '
    cd /tmp && npm i --silent @n8n/scan-community-package@beta >/dev/null 2>&1
    cat > /tmp/run.mjs <<EOF
import { analyzePackage, SOURCE_FILE_PATTERNS } from "/tmp/node_modules/@n8n/scan-community-package/scanner/scanner.mjs";
const s = await analyzePackage("/work/checkout/src", SOURCE_FILE_PATTERNS);
const d = await analyzePackage("/work/tarball/pkg", ["**/*.js", "package.json"]);
if (s.details) console.log("--- source ---\n" + s.details);
if (d.details) console.log("--- dist ---\n" + d.details);
console.log("VERDICT: " + (s.passed && d.passed ? "PASS" : "FAIL"));
process.exit(s.passed && d.passed ? 0 : 1);
EOF
    node /tmp/run.mjs
  '

echo "→ Rappel : la provenance n'est pas testee ici, elle ne vient que de la CI."
