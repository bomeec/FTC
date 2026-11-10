// Node에서 배정 결과를 확인하기 위한 실행 스크립트
// 사용법: node run.js [seed]
const fs = require("fs");
const path = require("path");
const { assignCourts, formatAssignments } = require("./assign");

const info = JSON.parse(
  fs.readFileSync(path.join(__dirname, "info.json"), "utf-8")
);

const seedArg = process.argv[2];
const options = seedArg !== undefined ? { seed: Number(seedArg) } : {};

const assignments = assignCourts(info, options);
console.log(formatAssignments(assignments));

if (assignments.warning) {
  console.log("⚠️  " + assignments.warning);
}
