// Shared-shape deterministic fixture for the actual Firefox addon audit.
// It deliberately includes more than five companies, tied, zero and unknown
// scores, and a different ranking in every source time window. Acceptance values
// include genuine zero/100%, fractional precision, missing and invalid inputs.
export function makeFixture(core) {
  const commit = '1234567890abcdef1234567890abcdef12345678';
  const now = new Date().toISOString();
  const names = ['Amazon', 'Apple', 'Bloomberg', 'Google', 'Meta', 'Microsoft', 'Spotify'];
  const base = { Amazon: 100, Apple: 91, Bloomberg: 50, Google: 91, Meta: 0, Microsoft: null, Spotify: 65 };
  const second = { Amazon: 180, Apple: 100, Bloomberg: 40, Google: 200, Meta: 150, Microsoft: 90, Spotify: 50 };
  const acceptance = {
    'two-sum': 0.5,
    'add-two-numbers': 0.456,
    'merge-two-sorted-lists': 0,
    'binary-tree-level-order-traversal': '',
    'valid-parentheses': 1,
    'longest-substring-without-repeating-characters': 'not-a-rate',
    'maximum-depth-of-binary-tree': 0.74123,
  };
  const scores = {
    all: base,
    '30d': { Amazon: 40, Apple: 0, Bloomberg: null, Google: 99, Meta: 88, Microsoft: null, Spotify: null },
    '3m': { ...base, Spotify: 200 },
    '6m': { ...base, Meta: 160 },
    older: { ...base, Bloomberg: 120 },
  };
  const descriptors = [], files = {};
  const cell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  for (const [window, filename] of Object.entries(core.WINDOW_FILES)) {
    for (const name of names) {
      const records = [
        ['EASY', 'Two Sum', scores[window][name], 'two-sum', 'Array, Hash Table'],
        ['MEDIUM', 'Add Two Numbers', second[name], 'add-two-numbers', 'Linked List, Math'],
      ];
      if (name === 'Amazon') records.push(
        ['EASY', 'Merge Two Sorted Lists', 85, 'merge-two-sorted-lists', 'Linked List, Recursion'],
        ['MEDIUM', 'Binary Tree Level Order Traversal', 75, 'binary-tree-level-order-traversal', 'Tree, Breadth-First Search'],
        ['EASY', 'Valid Parentheses', 70, 'valid-parentheses', 'String, Stack'],
        ['MEDIUM', 'Longest Substring Without Repeating Characters', 65, 'longest-substring-without-repeating-characters', 'Hash Table, Sliding Window'],
        ['EASY', 'Maximum Depth of Binary Tree', 50, 'maximum-depth-of-binary-tree', 'Tree, Depth-First Search'],
      );
      const relativePath = `${name}/${filename}`;
      const sha = (descriptors.length + 1).toString(16).padStart(40, '0');
      const csv = 'Difficulty,Title,Frequency,Acceptance Rate,Link,Topics\n' + records.map(
        ([difficulty, title, frequency, slug, topics]) => [difficulty, title, frequency, acceptance[slug],
          `https://leetcode.com/problems/${slug}/`, topics].map(cell).join(',')).join('\n');
      descriptors.push({ path: relativePath, name, window, sha });
      files[relativePath] = { sha, records: core.parseCompanyRecords(csv) };
    }
  }
  const data = core.buildData(descriptors, files, commit, now, now);
  return {
    commit,
    seed: { lctData: data, lctStatus: { phase: 'idle', completed: 35, total: 35,
      message: 'Up to date.', lastCheckedAt: now, lastSyncedAt: now, sourceUpdatedAt: now,
      commit, companyCount: data.companyCount, problemCount: data.problemCount, hasData: true },
      lctSettings: { enabled: true, collapsed: false, window: 'all' }, lctStage: null, lctCache: null },
    html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two Sum - LeetCode</title><style>body{background:#171717;color:#eee;font:16px system-ui;margin:40px;max-width:700px}h1{font-size:30px}pre{background:#292929;padding:24px}header{color:#ffa116}</style></head><body><header>LeetCode / Problems</header><h1>1. Two Sum</h1><p>Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.</p><pre>Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]</pre></body></html>',
  };
}
