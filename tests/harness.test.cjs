const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildClaudeLaunch, projectMemoryDirectory } = require('../harness');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aside-harness-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(home, 'my-project');
  const isolatedCwd = path.join(root, 'isolated');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(isolatedCwd);
  return { home, project, isolatedCwd, asidePrompt: 'Answer briefly.' };
}
const value = (args, flag) => args[args.indexOf(flag) + 1];

test('harness keeps native prompt and limits tool capabilities independently of skills', t => {
  const f = fixture(t);
  const { args, cwd } = buildClaudeLaunch({ ...f, cfg: { projectPath: f.project } });
  assert.equal(cwd, f.project);
  assert.ok(args.includes('--restricted'));
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep');
  assert.equal(value(args, '--permission-mode'), 'dontAsk');
  assert.equal(value(args, '--permission-prompts'), 'none');
  assert.equal(value(args, '--mcp-config'), '{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--system-prompt'));
  assert.match(value(args, '--append-system-prompt'), /Answer briefly/);
  const settings = JSON.parse(value(args, '--settings'));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.autoMemoryEnabled, false);
  for (const tool of ['Bash', 'PowerShell', 'Write', 'Edit', 'Agent', 'Task', 'mcp__*']) {
    assert.ok(settings.permissions.deny.includes(tool));
    assert.ok(value(args, '--disallowedTools').split(',').includes(tool));
  }
});

test('loads only selected project memory index, including git-root memory for subdirectories', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.project, '.git'));
  const nested = path.join(f.project, 'src'); fs.mkdirSync(nested);
  const memory = projectMemoryDirectory(f.project, f.home);
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), 'SELECTED_MEMORY\n[detail](detail.md)');
  fs.writeFileSync(path.join(memory, 'detail.md'), 'DO_NOT_EAGERLY_LOAD');
  const unrelated = projectMemoryDirectory(path.join(f.home, 'other'), f.home);
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(unrelated, 'MEMORY.md'), 'UNRELATED_MEMORY');
  const { args } = buildClaudeLaunch({ ...f, cfg: { projectPath: nested } });
  const prompt = value(args, '--append-system-prompt');
  assert.match(prompt, /SELECTED_MEMORY/);
  assert.ok(!prompt.includes('DO_NOT_EAGERLY_LOAD'));
  assert.ok(!prompt.includes('UNRELATED_MEMORY'));
  assert.ok(args.includes(memory));
});

test('no project uses isolated cwd and no project memory; voice is bounded', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude', 'voice.md'), Array.from({ length: 150 }, (_, n) => `VOICE_${n}`).join('\n'));
  const { args, cwd } = buildClaudeLaunch({ ...f, cfg: {} });
  assert.equal(cwd, f.isolatedCwd);
  const prompt = value(args, '--append-system-prompt');
  assert.match(prompt, /VOICE_99/);
  assert.ok(!prompt.includes('VOICE_100'));
  assert.ok(!prompt.includes('Existing project memory index'));
});

test('legacy mode remains tool-free and uses Aside system prompt', t => {
  const f = fixture(t);
  const { args, cwd } = buildClaudeLaunch({ ...f, cfg: { useHarness: false, projectPath: f.project } });
  assert.equal(cwd, f.isolatedCwd);
  assert.equal(value(args, '--tools'), '');
  assert.equal(value(args, '--setting-sources'), '');
  assert.equal(value(args, '--system-prompt'), f.asidePrompt);
  assert.ok(!args.includes('--append-system-prompt'));
});

test('rejects nonexistent or non-directory project paths', t => {
  const f = fixture(t);
  assert.throws(() => buildClaudeLaunch({ ...f, cfg: { projectPath: path.join(f.home, 'missing') } }));
  const file = path.join(f.home, 'file'); fs.writeFileSync(file, 'x');
  assert.throws(() => buildClaudeLaunch({ ...f, cfg: { projectPath: file } }), /project folder/);
});

test('allows referenced symlink skill directories without enabling arbitrary tools', t => {
  const f = fixture(t);
  const skills = path.join(f.home, '.claude', 'skills'); fs.mkdirSync(skills, { recursive: true });
  const shared = path.join(f.home, 'shared-skill'); fs.mkdirSync(shared);
  fs.symlinkSync(shared, path.join(skills, 'one'));
  const { args } = buildClaudeLaunch({ ...f, cfg: {} });
  assert.ok(args.includes(skills)); assert.ok(args.includes(shared));
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep');
});

test('explicitly loads global and project instructions, catalogs skill guidance without executing or loading bodies', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, '.claude', 'skills', 'personal'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude', 'CLAUDE.md'), 'GLOBAL_INSTRUCTION_MARKER');
  fs.writeFileSync(path.join(f.project, 'CLAUDE.md'), 'PROJECT_INSTRUCTION_MARKER');
  fs.writeFileSync(path.join(f.home, '.claude', 'skills', 'personal', 'SKILL.md'), '---\nname: personal\ndescription: Personal guidance\n---\nBODY_NOT_EAGERLY_LOADED');
  const local = path.join(f.project, '.claude', 'skills', 'local');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'SKILL.md'), '---\nname: local\ndescription: Local guidance\ndisable-model-invocation: true\n---\n!`touch /tmp/NEVER_EXECUTE`');
  const { args } = buildClaudeLaunch({ ...f, cfg: { projectPath: f.project } });
  const prompt = value(args, '--append-system-prompt');
  assert.match(prompt, /GLOBAL_INSTRUCTION_MARKER/);
  assert.match(prompt, /PROJECT_INSTRUCTION_MARKER/);
  assert.match(prompt, /personal: Personal guidance/);
  assert.match(prompt, /local \[only when explicitly requested\]: Local guidance/);
  assert.ok(!prompt.includes('BODY_NOT_EAGERLY_LOADED'));
  assert.ok(!prompt.includes('touch /tmp/NEVER_EXECUTE'));
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep');
  assert.ok(value(args, '--disallowedTools').split(',').includes('Skill'));
});

test('subdirectory selection catalogs repository-root skills', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.project, '.git'));
  const skill = path.join(f.project, '.claude', 'skills', 'root-skill');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: root-skill\ndescription: Shared root guidance\n---\n');
  const nested = path.join(f.project, 'src'); fs.mkdirSync(nested);
  const { args } = buildClaudeLaunch({ ...f, cfg: { projectPath: nested } });
  assert.match(value(args, '--append-system-prompt'), /root-skill: Shared root guidance/);
});
