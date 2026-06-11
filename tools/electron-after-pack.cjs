const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const projectDir = context.packager.projectDir;
  const iconPath = path.join(projectDir, "build", "icon.ico");
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);

  if (!fs.existsSync(iconPath)) {
    throw new Error(`[apex] Missing Windows icon at ${iconPath}`);
  }
  if (!fs.existsSync(exePath)) {
    throw new Error(`[apex] Missing packaged executable at ${exePath}`);
  }

  const rceditPath = findRcedit();
  if (!rceditPath) {
    throw new Error(
      "[apex] Could not find rcedit-x64.exe in the electron-builder cache. " +
      "Run electron-builder once so it can populate winCodeSign, then retry.",
    );
  }

  console.log(`[apex] Stamping Windows executable icon with ${path.relative(projectDir, iconPath)}`);
  execFileSync(
    rceditPath,
    [
      exePath,
      "--set-icon",
      iconPath,
      "--set-version-string",
      "ProductName",
      "Apex",
      "--set-version-string",
      "FileDescription",
      "Apex",
    ],
    { stdio: "inherit" },
  );
};

function findRcedit() {
  const cacheRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache", "winCodeSign")
    : null;
  if (!cacheRoot || !fs.existsSync(cacheRoot)) return null;

  const preferred = process.arch === "ia32" ? "rcedit-ia32.exe" : "rcedit-x64.exe";
  const matches = [];
  collect(cacheRoot, preferred, matches);
  if (!matches.length && preferred !== "rcedit-x64.exe") {
    collect(cacheRoot, "rcedit-x64.exe", matches);
  }

  return matches
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((match) => match.file)
    .at(0) || null;
}

function collect(dir, targetName, matches) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(fullPath, targetName, matches);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
      const stat = fs.statSync(fullPath);
      matches.push({ file: fullPath, mtimeMs: stat.mtimeMs });
    }
  }
}
