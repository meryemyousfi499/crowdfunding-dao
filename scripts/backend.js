// « Backend » local : déploie, (peuple), puis lance EN PARALLÈLE le robot d'exécution (keeper)
// et la surveillance IA de fraude (Python, mise à jour toutes les 20 s). Ctrl+C arrête tout.
//   npm run backend         deploy + keeper + fraude
//   npm run backend:seed    deploy + seed + keeper + fraude
const { spawn, spawnSync } = require("child_process");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args) => spawnSync(npx, ["hardhat", "run", ...args, "--network", "localhost"], { stdio: "inherit", shell: process.platform === "win32" });
if (run(["scripts/deploy.js"]).status) process.exit(1);
if (process.argv.includes("--seed") && run(["scripts/seed.js"]).status) process.exit(1);
const kids = [spawn(npx, ["hardhat", "run", "scripts/keeper.js", "--network", "localhost"], { stdio: "inherit", shell: process.platform === "win32" })];
if (process.env.NO_FRAUD !== "1") {
  const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const f = spawn(py, ["analysis/fraud_detector.py", "--watch", process.env.FRAUD_EVERY || "20", "--fast"], { stdio: "inherit" });
  f.on("error", () => console.warn("[fraude] Python introuvable : surveillance IA désactivée (NO_FRAUD=1 pour masquer ce message)."));
  kids.push(f);
}
const stop = () => { kids.forEach((k) => k.kill()); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
kids[0].on("exit", stop);