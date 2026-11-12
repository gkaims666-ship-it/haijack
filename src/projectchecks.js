// Команды проверок проекта: как здесь запускают тесты, линтер, проверку типов и сборку.
// Определяются по файлам проекта, чтобы агенты не угадывали, а запускали то, что в проекте принято.

import fs from 'node:fs';
import path from 'node:path';

const KIND_LABEL = { test: 'тесты', lint: 'линтер', types: 'проверка типов', build: 'сборка' };

/** @returns {Array<{kind: 'test'|'lint'|'types'|'build', command: string, source: string}>} */
export function detectChecks(cwd) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  const read = (f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } };
  const out = [];
  const add = (kind, command, source) => { if (!out.some((c) => c.kind === kind)) out.push({ kind, command, source }); };

  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(read('package.json')); } catch { /* повреждён — скрипты неизвестны */ }
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const run = (name) => (name === 'test' ? `${pm} test` : `${pm} run ${name}`);
    const real = (name) => typeof scripts[name] === 'string' && !/no test specified/.test(scripts[name]);
    if (real('test')) add('test', run('test'), 'package.json');
    for (const name of ['lint', 'eslint']) if (real(name)) add('lint', run(name), 'package.json');
    for (const name of ['typecheck', 'type-check', 'check-types', 'tsc']) if (real(name)) add('types', run(name), 'package.json');
    if (!out.some((c) => c.kind === 'types') && has('tsconfig.json')) add('types', `${pm === 'npm' ? 'npx' : pm} tsc --noEmit`, 'tsconfig.json');
    if (real('build')) add('build', run('build'), 'package.json');
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py') || has('requirements.txt') || has('tox.ini')) {
    const py = read('pyproject.toml');
    if (has('pytest.ini') || /\[tool\.pytest/.test(py) || has('tests') || has('test') || has('conftest.py')) add('test', 'python -m pytest -q', 'pytest');
    if (/\[tool\.ruff/.test(py) || has('ruff.toml') || has('.ruff.toml')) add('lint', 'ruff check .', 'ruff');
    else if (has('.flake8') || /\[flake8\]/.test(read('setup.cfg') + read('tox.ini'))) add('lint', 'flake8', 'flake8');
    if (/\[tool\.mypy/.test(py) || has('mypy.ini')) add('types', 'mypy .', 'mypy');
  }
  if (has('Cargo.toml')) { add('test', 'cargo test', 'Cargo.toml'); add('lint', 'cargo clippy --all-targets', 'Cargo.toml'); add('build', 'cargo build', 'Cargo.toml'); }
  if (has('go.mod')) { add('test', 'go test ./...', 'go.mod'); add('lint', 'go vet ./...', 'go.mod'); add('build', 'go build ./...', 'go.mod'); }
  if (has('pom.xml')) add('test', 'mvn -q test', 'pom.xml');
  if (has('build.gradle') || has('build.gradle.kts')) add('test', has('gradlew') || has('gradlew.bat') ? (process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test') : 'gradle test', 'Gradle');
  if (has('composer.json')) {
    try { if (JSON.parse(read('composer.json')).scripts?.test) add('test', 'composer test', 'composer.json'); } catch { /* повреждён */ }
    if (!out.some((c) => c.kind === 'test') && (has('phpunit.xml') || has('phpunit.xml.dist'))) add('test', 'vendor/bin/phpunit', 'phpunit.xml');
  }
  if (has('Gemfile')) add('test', has('spec') ? 'bundle exec rspec' : 'bundle exec rake test', 'Gemfile');
  if (has('Makefile')) {
    const mk = read('Makefile');
    for (const [target, kind] of [['test', 'test'], ['lint', 'lint'], ['build', 'build']]) if (new RegExp(`^${target}\\s*:`, 'm').test(mk)) add(kind, `make ${target}`, 'Makefile');
  }
  if (has('.csproj') || fs.readdirSync(cwd, { withFileTypes: true }).some((e) => e.isFile() && /\.(sln|csproj)$/.test(e.name))) add('test', 'dotnet test', '.NET');
  return out;
}

/** Блок для сообщения агенту; пустая строка, если ничего не определилось */
export function checksBlock(cwd) {
  let checks;
  try { checks = detectChecks(cwd); } catch { return ''; }
  if (!checks.length) return '';
  return `# Проверки проекта (определены автоматически — используй именно эти команды)\n${checks.map((c) => `- ${KIND_LABEL[c.kind]}: \`${c.command}\` (${c.source})`).join('\n')}\n\n`;
}

export function formatChecks(checks) {
  return checks.map((c) => `${KIND_LABEL[c.kind]} — ${c.command}`).join('; ');
}
