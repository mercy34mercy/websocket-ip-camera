import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

// Basic認証の設定
const basicAuth = (req, res, next) => {
  // 認証情報
  const authUser = 'infolab';
  const authPassword = 'InfoNetworking';

  // リクエストヘッダーから認証情報を取得
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // 認証情報がない場合は認証を要求
    res.setHeader('WWW-Authenticate', 'Basic realm="WebRTC Video Streaming"');
    res.status(401).send('認証が必要です');
    return;
  }
  
  // Basic認証の値をデコード
  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const user = auth[0];
  const password = auth[1];
  
  // 認証情報の検証
  if (user === authUser && password === authPassword) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="WebRTC Video Streaming"');
    res.status(401).send('認証に失敗しました');
  }
};

// ディレクトリパスの設定
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Expressアプリケーションの作成
const app = express();

const server = http.createServer(app);
const io = new Server(server);

// すべてのルートにBasic認証を適用
app.use(basicAuth);

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, '../public')));

// 動画ストリーミング関連の変数
let ffmpegProcess = null;
let connectedClients = 0;
let streamActive = false;
let mjpegReqCount = 0;
let wsServer = null;
let streamHttpServer = null;
let currentVideoDevice = '/dev/video2'; // デフォルトのカメラデバイス

// FFmpegを使った動画ストリーミングの開始
function startVideoStream() {
  if (streamActive) return; // すでに起動している場合は何もしない
  
  console.log('カメラストリーミングを開始します...');
  streamActive = true;
  
  // MJPEGストリームのエンドポイント
  app.get('/stream', (req, res) => {
    const reqId = ++mjpegReqCount;
    console.log(`新しいストリームリクエスト ${reqId} を受信しました`);
    
    // HTTPヘッダーの設定
    res.writeHead(200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
      'Pragma': 'no-cache',
      'Connection': 'close',
      'Content-Type': 'multipart/x-mixed-replace; boundary=--jpgboundary'
    });
    
    // クライアントが切断したときの処理
    req.on('close', () => {
      console.log(`ストリームリクエスト ${reqId} が終了しました`);
    });
    
    // 最初のバウンダリを送信
    res.write('--jpgboundary\r\n');
    
    // ストリーミングの開始を通知
    io.emit('stream-started', { url: '/stream' });
    
    // FFmpegプロセスがまだ起動していない場合は起動
    if (!ffmpegProcess) {
      startFFmpeg();
    }
  });
}

function stopVideoStream() {
  if (!streamActive) return;

  console.log('カメラストリーミングを停止します...');
  streamActive = false;

  if (ffmpegProcess) {
    console.log('FFmpegプロセスを終了します...');
    try {
      ffmpegProcess.stdin.write('q');  // FFmpegに終了信号を送る
      setTimeout(() => {
        if (ffmpegProcess) {
          ffmpegProcess.kill('SIGTERM');
          setTimeout(() => {
            if (ffmpegProcess) {
              ffmpegProcess.kill('SIGKILL');
            }
          }, 1000);
        }
      }, 500);
    } catch (err) {
      console.error('FFmpeg終了エラー:', err);
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
      }
    }
    ffmpegProcess = null;
  }
}

// カメラデバイスを切り替える関数
function switchVideoDevice(newDevice) {
  console.log(`カメラデバイスを ${currentVideoDevice} から ${newDevice} に切り替えます...`);

  const wasActive = streamActive;

  // 現在のストリームを停止
  if (ffmpegProcess) {
    try {
      ffmpegProcess.kill('SIGTERM');
      setTimeout(() => {
        if (ffmpegProcess) {
          ffmpegProcess.kill('SIGKILL');
        }
      }, 1000);
    } catch (err) {
      console.error('FFmpeg終了エラー:', err);
    }
    ffmpegProcess = null;
  }

  // デバイスを変更
  currentVideoDevice = newDevice;

  // ストリームが有効だった場合は再起動
  if (wasActive && connectedClients > 0) {
    setTimeout(() => {
      console.log('新しいデバイスでFFmpegを再起動します...');
      startFFmpeg();
    }, 1500);
  }

  return currentVideoDevice;
}

// FFmpegプロセスを起動してカメラからMJPEGストリームを生成
function startFFmpeg() {
  try {
    // FFmpegコマンドの構築（Raspberry Piの場合）
    const ffmpegCmd = 'ffmpeg';
    const ffmpegArgs = [
      '-f', 'v4l2',              // Linuxのビデオ入力フレームワーク
      '-framerate', '30',        // フレームレート
      '-video_size', '1280x720', // 解像度
      '-input_format', 'mjpeg',  // RasPiカメラの入力フォーマット
      '-i', currentVideoDevice,  // ビデオデバイス
      '-c:v', 'mpeg1video',      // ビデオコーデック
      '-f', 'mpegts',            // 出力フォーマット
      '-b:v', '800k',            // ビットレート
      '-bf', '0',                // Bフレームなし
      '-g', '30',                // キーフレーム間隔
      '-q:v', '5',               // 品質レベル (低い値ほど高品質)
      '-r', '25',                // 出力フレームレート
      '-threads', '2',           // スレッド数を減らして安定化
      '-http_persistent', '0',   // 持続的HTTPクライアントを無効化
      'http://localhost:8081/yoursecret'  // HTTPで出力先を指定
    ];
    
    console.log('FFmpegを起動します:', ffmpegCmd, ffmpegArgs.join(' '));
    
    // FFmpegプロセスの起動（標準入力を維持して制御可能に）
    ffmpegProcess = spawn(ffmpegCmd, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // 標準出力のログ
    ffmpegProcess.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });
    
    // エラー出力のログ
    ffmpegProcess.stderr.on('data', (data) => {
      console.error(`FFmpeg stderr: ${data}`);
    });
    
    // プロセスが終了した場合の処理
    ffmpegProcess.on('close', (code) => {
      console.log(`FFmpegが終了しました (code: ${code})`);
      ffmpegProcess = null;
      
      // エラーコードが異常終了の場合は再起動を試みる
      if (code !== 0 && code !== 255 && streamActive) {
        console.log('FFmpegを再起動します...');
        setTimeout(() => {
          if (streamActive && !ffmpegProcess) {
            startFFmpeg();
          }
        }, 2000);
      }
    });
    
  } catch (err) {
    console.error('FFmpeg起動エラー:', err);
  }
}

// Socket.io接続ハンドラ
io.on('connection', (socket) => {
  console.log('クライアントが接続しました:', socket.id);
  connectedClients++;

  // 現在のデバイス情報を送信
  socket.emit('current-device', { device: currentVideoDevice });

  // クライアントが1人以上接続していたらストリーミングを開始
  if (connectedClients === 1) {
    startVideoStream();
    // FFmpegプロセスを起動（既に開始されていなければ）
    if (!ffmpegProcess) {
      startFFmpeg();
    }
  }

  // デバイス切り替えリクエストの処理
  socket.on('switch-device', (data) => {
    console.log('デバイス切り替えリクエストを受信:', data.device);
    const newDevice = switchVideoDevice(data.device);
    // 全クライアントに新しいデバイス情報を通知
    io.emit('current-device', { device: newDevice });
  });

  // クライアント切断時の処理
  socket.on('disconnect', () => {
    console.log('クライアントが切断しました:', socket.id);
    connectedClients--;

    // 接続中のクライアントがいなくなったらストリーミングを停止
    if (connectedClients === 0) {
      stopVideoStream();
    }
  });
});

// WebSocketサーバーを構築するための簡易HTTPサーバー
function setupWebSocketServer() {
  const HTTP_PORT = 8081;
  
  streamHttpServer = http.createServer((req, res) => {
    // FFmpegからのHTTPリクエストを処理
    if (req.method === 'OPTIONS') {
        // プリフライトリクエストに対応
        res.writeHead(200);
        res.end();
        return;
      }

    if (req.url === '/yoursecret') {
      res.writeHead(200, {
        'Content-Type': 'video/mpeg',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
      });
      
      // HTTPリクエストをWSServerに転送するためのデータハンドラ
      req.on('data', (chunk) => {
        if (wsServer) {
          for (const client of wsServer.clients) {
            if (client.readyState === 1) { // OPEN
              try {
                client.send(chunk);
              } catch (e) {
                console.error('クライアントへの送信に失敗:', e);
              }
            }
          }
        }
      });
      
      req.on('end', () => {
        console.log('FFmpegからのリクエストが終了しました');
      });
      
      req.on('error', (err) => {
        console.error('FFmpegリクエストエラー:', err);
      });
      
      // リクエストが切断されたときの処理
      req.socket.on('close', () => {
        console.log('FFmpeg接続が閉じられました');
      });
    } else {
      // 通常の404レスポンス
      res.writeHead(404);
      res.end();
    }
  }).listen(HTTP_PORT, () => {
    console.log(`Streaming HTTPサーバーが起動しました: http://localhost:${HTTP_PORT}`);
  });

  // WebSocketサーバーの作成
  wsServer = new WebSocketServer({ server: streamHttpServer, path: '/yoursecret' });

  wsServer.on('connection', (socket, req) => {
    console.log('WebSocketクライアントが接続しました');
    
    // URLからクエリパラメータを取得して認証を検証
    const url = new URL(req.url, 'http://localhost');
    const authParam = url.searchParams.get('auth');
    
    if (!authParam) {
      console.log('認証情報がありません、接続を切断します');
      socket.close();
      return;
    }
    
    try {
      const authDecoded = Buffer.from(authParam, 'base64').toString().split(':');
      const user = authDecoded[0];
      const password = authDecoded[1];
      
      if (user !== 'user' || password !== 'InfoNetworking') {
        console.log('認証に失敗しました、接続を切断します');
        socket.close();
        return;
      }
      
      console.log('WebSocketクライアントの認証に成功しました');
    } catch (e) {
      console.error('認証デコードエラー:', e);
      socket.close();
      return;
    }
    
    socket.on('close', () => {
      console.log('WebSocketクライアントが切断しました');
    });
  });
}

// WebSocketサーバーのセットアップを実行
setupWebSocketServer();

// ルートへのアクセス
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ストリーム表示用のエンドポイント
app.get('/view', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>カメラストリーム</title>
      <style>
        body { margin: 0; padding: 0; background: #000; }
        #video-container { width: 100vw; height: 100vh; display: flex; justify-content: center; align-items: center; }
        #video { max-width: 100%; max-height: 100%; }
      </style>
    </head>
    <body>
      <div id="video-container">
        <canvas id="video"></canvas>
      </div>
      <script src="/jsmpeg.min.js"></script>
      <script>
        // Basic認証情報をURLに含める
        const username = 'user';
        const password = 'InfoNetworking';
        const auth = btoa(username + ':' + password);
        const wsUrl = 'ws://localhost:8081/yoursecret?auth=' + auth;
        
        new JSMpeg.Player(wsUrl, {
          canvas: document.getElementById('video'),
          autoplay: true,
          audio: false,
          loop: false
        });
      </script>
    </body>
    </html>
  `);
});

// サーバー起動
const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});

// プロセス終了時のクリーンアップ
process.on('SIGINT', () => {
  console.log('サーバーを終了します...');
  stopVideoStream();
  
  if (wsServer) {
    wsServer.close();
  }
  
  if (streamHttpServer) {
    streamHttpServer.close();
  }
  
  process.exit();
});
