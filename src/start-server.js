// サーバー起動用のシンプルなスクリプト
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('サーバーカメラ配信を起動します...');

// サーバープロセスを起動
const serverProcess = spawn('node', ['index.js'], {
  stdio: 'inherit',
  cwd: __dirname
});

// 終了処理
process.on('SIGINT', () => {
  console.log('サーバーを終了します...');
  serverProcess.kill('SIGINT');
  process.exit(0);
});

// エラーハンドリング
serverProcess.on('error', (err) => {
  console.error('サーバー起動エラー:', err);
  process.exit(1);
});

serverProcess.on('exit', (code) => {
  console.log(`サーバーが終了しました (code: ${code})`);
  process.exit(code);
}); 