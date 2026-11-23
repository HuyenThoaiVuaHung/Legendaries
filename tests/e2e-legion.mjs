/**
 * End-to-end check of the .legion + media pipeline against a running server.
 * Run: node tests/e2e-legion.mjs [port]
 */
import { createRequire } from 'module';
const AdmZip = createRequire(import.meta.url)('adm-zip');

const port = process.argv[2] ?? '8080';
const base = `http://localhost:${port}`;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

// 1×1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// --- login as admin ------------------------------------------------------
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ secret: 'BTC' }),
}).then((r) => r.json());
const auth = { authorization: `Bearer ${login.token}` };
check('admin login', login.roleId === 1);

// --- SPA serving ----------------------------------------------------------
const index = await fetch(`${base}/`).then((r) => r.text());
check('index.html served', index.includes('<app-root'));
const spa = await fetch(`${base}/admin/kd`).then((r) => r.text());
check('SPA fallback serves index for deep link', spa.includes('<app-root'));

// --- image upload ---------------------------------------------------------
const uploadForm = new FormData();
uploadForm.append('file', new Blob([PNG], { type: 'image/png' }), 'e2e-test.png');
const upload = await fetch(`${base}/api/media/tt`, {
  method: 'POST',
  headers: auth,
  body: uploadForm,
}).then((r) => r.json());
check('image upload returns fileName+url', Boolean(upload.fileName && upload.url), JSON.stringify(upload));

const served = await fetch(`${base}${upload.url}`);
check('uploaded image served', served.status === 200 && served.headers.get('content-type')?.includes('image'));

// --- .legion import -------------------------------------------------------
const editorData = {
  uid: 'e2e-uid',
  dateModified: 0,
  uiConfig: { darkMode: false, pallette: 0, miscImageSrcNames: {} },
  matchData: {
    matchName: 'E2E Cup',
    matchVersion: 24,
    matchPos: 0,
    players: [
      { name: 'An', score: 0, isReady: false },
      { name: 'Bình', score: 0, isReady: false },
      { name: 'Chi', score: 0, isReady: false },
      { name: 'Dũng', score: 0, isReady: false },
    ],
  },
  questionBank: {
    kd: {
      o24Questions: {
        0: [{ question: 'KD multi 1?', answer: 'A', type: 0, value: 10 }],
        1: [[{ question: 'KD single P1?', answer: 'B', type: 0, value: 10 }], [], [], []],
      },
    },
    vcnv: {
      cnv: 'HOANG SA',
      cnvMediaSrcNames: ['obstacle.png'],
      questions: [1, 2, 3, 4, 5].map((i) => ({
        question: `Row ${i}?`, answer: `R${i}`, type: 0, value: 10,
      })),
    },
    tt: {
      questions: [{
        question: 'TT 1?', answer: 'T', type: 1, value: 10, mediaSrcName: 'tt1.png',
      }],
    },
    vd: {
      questions: [[{ question: 'VD P1?', answer: 'V', type: 0, value: 20 }], [], [], []],
    },
    chp: { questions: [{ question: 'CHP?', answer: 'C', type: 0, value: 1 }] },
  },
};
const zip = new AdmZip();
zip.addFile('editorData.json', Buffer.from(JSON.stringify(editorData)));
zip.addFile('vcnv/obstacle.png', PNG);
zip.addFile('tt/tt1.png', PNG);

const legionForm = new FormData();
legionForm.append('file', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'e2e.legion');
const imported = await fetch(`${base}/api/match/import-legion`, {
  method: 'POST',
  headers: auth,
  body: legionForm,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
check('.legion import accepted', imported.status === 200 && imported.body?.matchName === 'E2E Cup', JSON.stringify(imported));

const match = await fetch(`${base}/api/match`, { headers: auth }).then((r) => r.json());
check('players imported', match.players?.[0]?.name === 'An' && match.players.length === 4, JSON.stringify(match.players));

const tt = await fetch(`${base}/api/rounds/tt`, { headers: auth }).then((r) => r.json());
const ttImg = tt.questions?.[0]?.questionImage;
check('tt round imported with randomized image name', typeof ttImg === 'string' && ttImg !== 'tt1.png' && ttImg.endsWith('-tt1.png'), JSON.stringify(tt.questions?.[0]));

const vcnv = await fetch(`${base}/api/rounds/vcnv`, { headers: auth }).then((r) => r.json());
check('vcnv has 5 rows and obstacle', vcnv.questions?.length === 5 && vcnv.obstacle?.answer === 'HOANG SA', JSON.stringify(vcnv.obstacle));

const predictableMedia = await fetch(`${base}/media/tt/tt1.png`);
check('predictable original filename is not served (404)', predictableMedia.status === 404, `status ${predictableMedia.status}`);
const importedMedia = await fetch(`${base}/media/tt/${encodeURIComponent(ttImg)}`);
check('imported media served at randomized URL', importedMedia.status === 200);

// --- .legion export -------------------------------------------------------
const exported = await fetch(`${base}/api/match/export-legion`, { headers: auth });
const exportBuf = Buffer.from(await exported.arrayBuffer());
let exportOk = exported.status === 200 && exportBuf.length > 0;
if (exportOk) {
  const outZip = new AdmZip(exportBuf);
  exportOk = outZip.getEntries().some((e) => e.entryName === 'editorData.json');
}
check('.legion export is a zip with editorData.json', exportOk, `status ${exported.status}, ${exportBuf.length}b`);

// --- 5-piece VCNV obstacle ingest + protected reveal + export round-trip ---
const fivePieceZip = new AdmZip();
const fivePieceNames = ['p0.png', 'p1.png', 'p2.png', 'p3.png', 'p4.png'];
fivePieceZip.addFile(
  'editorData.json',
  Buffer.from(
    JSON.stringify({
      matchData: editorData.matchData,
      questionBank: {
        ...editorData.questionBank,
        vcnv: {
          cnv: 'TRUONG SA',
          cnvMediaSrcNames: fivePieceNames,
          questions: editorData.questionBank.vcnv.questions,
        },
      },
    }),
  ),
);
for (const name of fivePieceNames) fivePieceZip.addFile(`vcnv/${name}`, PNG);
const fiveForm = new FormData();
fiveForm.append('file', new Blob([fivePieceZip.toBuffer()], { type: 'application/zip' }), 'five-pieces.legion');
const fiveImport = await fetch(`${base}/api/match/import-legion`, { method: 'POST', headers: auth, body: fiveForm });
check('5-piece .legion import accepted', fiveImport.status === 200);

const vcnv5 = await fetch(`${base}/api/rounds/vcnv`, { headers: auth }).then((r) => r.json());
check(
  '5-piece import populates imagePieceFiles and omits public imageFile',
  Array.isArray(vcnv5.obstacle?.imagePieceFiles) &&
    vcnv5.obstacle.imagePieceFiles.length === 5 &&
    vcnv5.obstacle.imageFile === undefined,
  JSON.stringify(vcnv5.obstacle),
);

const publicPieceLeak = await fetch(`${base}/media/vcnv/p0.png`);
check('5-piece import does not expose pieces in public /media/vcnv', publicPieceLeak.status === 404, `status ${publicPieceLeak.status}`);

const closedPieceViewer = await fetch(`${base}/api/media/obstacle/0`);
check('unrevealed obstacle piece denied to viewer (403)', closedPieceViewer.status === 403, `status ${closedPieceViewer.status}`);

const adminPiece = await fetch(`${base}/api/media/obstacle/0`, { headers: auth });
check('admin can fetch unrevealed obstacle piece (200)', adminPiece.status === 200, `status ${adminPiece.status}`);

const exported5 = await fetch(`${base}/api/match/export-legion`, { headers: auth });
const outZip5 = new AdmZip(Buffer.from(await exported5.arrayBuffer()));
const outData5 = JSON.parse(outZip5.getEntry('editorData.json').getData().toString('utf8'));
const exportedNames5 = outData5.questionBank?.vcnv?.cnvMediaSrcNames ?? [];
check(
  '5-piece export preserves all 5 piece names and bundles them in vcnv/',
  exportedNames5.length === 5 && exportedNames5.every((n) => outZip5.getEntry(`vcnv/${n}`)),
  JSON.stringify(exportedNames5),
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
