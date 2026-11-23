import AdmZip from 'adm-zip';
import { existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { BRAND_SLOTS, LegionImportResponse, UiConfig } from '../contracts/api';
import {
  ChpRound,
  KdQuestion,
  KdQuestionType,
  KdRound,
  MatchPosition,
  RoundKind,
  ROUND_KINDS,
  TtQuestion,
  TtRound,
  VcnvObstacle,
  VcnvQuestion,
  VcnvRound,
  VdQuestion,
  VdQuestionType,
  VdRound,
} from '../contracts/game';
import {
  DEFAULT_GAME_RULES,
  PLAYER_COUNT,
  VCNV_PIECE_COUNT,
  VCNV_ROW_COUNT,
} from '../game.rules';
import { MatchStore } from '../state/match.store';
import { ArchiveErrorCode, ArchiveParseError, parseArchiveBuffer, ParsedArchive } from './archive-worker';
import { validateMediaFile } from './media-validation';
import { UiConfigStore } from './ui-config.store';
import { MediaStore, sanitizeFileName } from './media.store';

// ---------------------------------------------------------------------------
// Editor (.legion) format — external contract owned by the Legion editor.
// These are the only places (besides state/legacy.adapter.ts) where non-
// canonical field names may appear (see PLAN: migration rules).
// ---------------------------------------------------------------------------

/** Numeric enum used by the editor's question JSON. */
enum EditorQuestionType {
  Text = 0,
  Image = 1,
  Audio = 2,
  Video = 3,
}

interface EditorQuestion {
  question: string;
  answer: string;
  type: EditorQuestionType;
  value: number;
  mediaSrcName?: string;
  secondaryMediaSrcName?: string;
}

interface EditorPlayer {
  name: string;
  score: number;
  isReady: boolean;
}

interface EditorMatchData {
  matchName: string;
  matchVersion: number;
  matchPos: number;
  players: EditorPlayer[];
}

interface EditorKdQuestionData {
  /** Keyed by O24ControlType; values are IQuestion[] or IQuestion[][]. */
  o24Questions?: Record<string, EditorQuestion[] | EditorQuestion[][]>;
  o23Questions?: EditorQuestion[][];
}

interface EditorVcnvQuestionData {
  questions: EditorQuestion[];
  cnv: string;
  cnvMediaSrcNames?: string[];
}

interface EditorQuestionBank {
  kd?: EditorKdQuestionData;
  vcnv?: EditorVcnvQuestionData;
  tt?: { questions: EditorQuestion[] };
  vd?: { questions: EditorQuestion[][] };
  chp?: { questions: EditorQuestion[] };
}

export interface EditorData {
  uiConfig?: unknown;
  matchData: EditorMatchData;
  questionBank: EditorQuestionBank;
  uid?: string;
  dateModified?: number;
}

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

const EDITOR_DATA_ENTRY = 'editorData.json';
const MAX_CONCURRENT_ARCHIVE_IMPORTS = 2;
let activeArchiveImports = 0;
/** Media folders a .legion archive may contain, mirrored as media kinds. */
const MEDIA_FOLDERS = [...ROUND_KINDS, 'misc'] as const;
type MediaFolder = (typeof MEDIA_FOLDERS)[number];

/** Round files an import writes; persisted paths are relative to server root. */
const IMPORTED_ROUND_DIR = 'match_data/round_data';
const importedRoundFile = (kind: RoundKind): string =>
  `${IMPORTED_ROUND_DIR}/imported_${kind}.json`;

/** A freshly imported match starts at the home screen. */
const IMPORT_START_POSITION: MatchPosition = 'H';
/** matchVersion the export declares (the current editor format). */
const EXPORT_MATCH_VERSION = 26;
/** Editor MatchPosition.IDLE — exports always start idle. */
const EDITOR_MATCH_POS_IDLE = 0;
/** Sentinel: no TT question is active yet. */
const NO_ACTIVE_QUESTION = -1;
/** Editor requires a point value on every question; TT scores by placement. */
const NO_STATIC_VALUE = 0;
const EXPORT_FALLBACK_NAME = 'match';

const KD_TYPE_BY_EDITOR: Record<EditorQuestionType, KdQuestionType> = {
  [EditorQuestionType.Text]: 'N',
  [EditorQuestionType.Image]: 'P',
  [EditorQuestionType.Audio]: 'A',
  [EditorQuestionType.Video]: 'N',
};

const VD_TYPE_BY_EDITOR: Record<EditorQuestionType, VdQuestionType> = {
  [EditorQuestionType.Text]: 'N',
  [EditorQuestionType.Image]: 'I',
  [EditorQuestionType.Audio]: 'A',
  [EditorQuestionType.Video]: 'V',
};

const EDITOR_TYPE_BY_VD: Record<VdQuestionType, EditorQuestionType> = {
  N: EditorQuestionType.Text,
  I: EditorQuestionType.Image,
  A: EditorQuestionType.Audio,
  V: EditorQuestionType.Video,
};

const EDITOR_TYPE_BY_KD: Record<KdQuestionType, EditorQuestionType> = {
  N: EditorQuestionType.Text,
  P: EditorQuestionType.Image,
  A: EditorQuestionType.Audio,
};

/**
 * Imports and exports the editor's `.legion`/`.lg` archives (a ZIP holding
 * editorData.json plus per-kind media folders), converting between the
 * editor's question bank and the canonical round contracts.
 */
export class QuotaError extends Error {
  constructor() {
    super('Room storage is full');
    this.name = 'QuotaError';
  }
}

export class ArchiveBusyError extends Error {
  constructor() {
    super('Too many archive imports in progress, try again shortly');
    this.name = 'ArchiveBusyError';
  }
}

export class ArchiveLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveLimitError';
  }
}

export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaError';
  }
}

export class LegionFileService {
  constructor(
    private readonly store: MatchStore,
    private readonly media: MediaStore,
    private readonly ui: UiConfigStore,
  ) {}

  /**
   * Unpack an archive off the main thread: extract media into the media store,
   * convert the question bank into fresh round files, and reset the match state.
   * The caller (HTTP route) is responsible for emitting the update-* pushes.
   */
  async importArchive(
    buffer: Buffer,
    options: { maxMediaBytes?: number } = {},
  ): Promise<LegionImportResponse> {
    const { editorData, files } = await parseArchiveAsync(buffer, options);
    return this.importData(editorData, files, options);
  }

  /** Load structured content and media directly, without an archive. */
  importData(editorData: EditorData, files: { folder: MediaFolder; name: string; data: Buffer }[], options: { maxMediaBytes?: number } = {}): LegionImportResponse {
    const totalMediaBytes = files.reduce((sum, file) => sum + file.data.length, 0);
    if (options.maxMediaBytes !== undefined && totalMediaBytes > options.maxMediaBytes) {
      throw new QuotaError();
    }
    for (const file of files) {
      if (!validateMediaFile(file.name, file.data)) {
        throw new UnsupportedMediaError(`Unsupported or invalid media file: ${file.name}`);
      }
    }
    const bank = editorData.questionBank;
    const rawObstaclePieces = (bank.vcnv?.cnvMediaSrcNames ?? []).filter(
      (name): name is string => typeof name === 'string' && name.trim() !== '',
    );
    const vcnvFilesByName = new Map<string, { folder: MediaFolder; name: string; data: Buffer }>();
    for (const file of files) {
      if (file.folder !== 'vcnv') continue;
      vcnvFilesByName.set(file.name, file);
      vcnvFilesByName.set(sanitizeFileName(file.name), file);
    }
    const matchedPieceFiles =
      rawObstaclePieces.length === VCNV_PIECE_COUNT
        ? rawObstaclePieces.map((name) => vcnvFilesByName.get(name) ?? vcnvFilesByName.get(sanitizeFileName(name)))
        : [];
    const hasAllProtectedPieces =
      matchedPieceFiles.length === VCNV_PIECE_COUNT && matchedPieceFiles.every((f) => f !== undefined);
    const rowReferencedVcnv = new Set(
      (bank.vcnv?.questions ?? [])
        .map((q) => q.mediaSrcName)
        .filter((name): name is string => typeof name === 'string' && name !== '')
        .flatMap((name) => [name, sanitizeFileName(name)]),
    );
    const protectedPieceSet = new Set(
      hasAllProtectedPieces
        ? matchedPieceFiles.flatMap((f) => [f!.name, sanitizeFileName(f!.name)])
        : [],
    );

    const mediaCounts: Partial<Record<MediaFolder, number>> = {};
    const storedByFolder = new Map<MediaFolder, Map<string, string>>();
    const recordStored = (folder: MediaFolder, originalName: string, storedName: string): void => {
      let map = storedByFolder.get(folder);
      if (!map) {
        map = new Map<string, string>();
        storedByFolder.set(folder, map);
      }
      map.set(originalName, storedName);
      map.set(sanitizeFileName(originalName), storedName);
    };
    const resolveMedia: MediaNameResolver = (folder, name) => {
      if (!name) return undefined;
      const map = storedByFolder.get(folder);
      return map?.get(name) ?? map?.get(sanitizeFileName(name)) ?? name;
    };
    const obstaclePieceFiles = hasAllProtectedPieces
      ? matchedPieceFiles.map((file) => {
          mediaCounts.vcnv = (mediaCounts.vcnv ?? 0) + 1;
          return this.media.saveObstaclePiece(file!.name, file!.data);
        })
      : undefined;

    const UNGUESSABLE_NAME = /^(?:[0-9a-f]{32}-|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.)/i;
    for (const file of files) {
      if (
        file.folder === 'vcnv' &&
        protectedPieceSet.has(file.name) &&
        !rowReferencedVcnv.has(file.name) &&
        !rowReferencedVcnv.has(sanitizeFileName(file.name))
      ) {
        continue;
      }
      const cleanName = sanitizeFileName(file.name);
      const stored = UNGUESSABLE_NAME.test(cleanName)
        ? this.media.saveWithName(file.folder, cleanName, file.data)
        : this.media.save(file.folder, file.name, file.data).fileName;
      recordStored(file.folder, file.name, stored);
      mediaCounts[file.folder] = (mediaCounts[file.folder] ?? 0) + 1;
    }
    const raw = editorData.uiConfig as Partial<UiConfig> | null;
    const names: UiConfig['miscImageSrcNames'] = {};
    const miscMap = storedByFolder.get('misc');
    for (const slot of BRAND_SLOTS) {
      const name = raw?.miscImageSrcNames?.[slot];
      const stored = typeof name === 'string' ? (miscMap?.get(name) ?? miscMap?.get(sanitizeFileName(name))) : undefined;
      if (stored) names[slot] = stored;
    }
    this.ui.set({
      darkMode: raw?.darkMode === true,
      pallette: typeof raw?.pallette === 'number' && Number.isFinite(raw.pallette) ? raw.pallette : 0,
      miscImageSrcNames: names,
    });

    const matchName = editorData.matchData.matchName ?? '';
    const importedPlayers = editorData.matchData.players ?? [];

    this.store.updateMatch((match) => {
      match.matchName = matchName;
      match.position = IMPORT_START_POSITION;
      match.pausedTimerSeconds = 0;
      match.players = Array.from({ length: PLAYER_COUNT }, (_, index) => ({
        id: index + 1,
        name: importedPlayers[index]?.name ?? match.players[index]?.name ?? '',
        score: 0,
        isReady: false,
      }));
      for (const kind of ROUND_KINDS) {
        match.roundFiles[kind] = importedRoundFile(kind);
      }
    });

    this.store.round('kd').set(mapKdRound(bank.kd, resolveMedia));
    this.store.round('vcnv').set(mapVcnvRound(bank.vcnv, obstaclePieceFiles, resolveMedia));
    this.store.round('tt').set(mapTtRound(bank.tt?.questions ?? [], resolveMedia));
    this.store.round('vd').set(mapVdRound(bank.vd?.questions ?? [], resolveMedia));
    this.store.round('chp').set(mapChpRound(bank.chp?.questions ?? []));

    return { matchName, mediaCounts };
  }

  /** Validate an archive without changing room state. */
  async inspect(buffer: Buffer): Promise<{ matchName: string }> {
    return inspectLegionArchive(buffer);
  }

  /**
   * Best-effort inverse of importArchive: rebuild editorData.json from the
   * current canonical data and bundle every referenced media file that still
   * exists on disk.
   */
  exportData(): EditorData {
    const match = this.store.getMatch();
    const kd = this.store.round('kd').get();
    const vcnv = this.store.round('vcnv').get();
    const tt = this.store.round('tt').get();
    const vd = this.store.round('vd').get();
    const chp = this.store.round('chp').get();

    const obstacle = vcnv.obstacle;
    const vcnvRows = vcnv.questions;

    const editorData: EditorData = {
      uid: randomUUID(),
      dateModified: Date.now(),
      uiConfig: this.ui.get(),
      matchData: {
        matchName: match.matchName,
        matchVersion: EXPORT_MATCH_VERSION,
        matchPos: EDITOR_MATCH_POS_IDLE,
        players: match.players.map((p) => ({
          name: p.name,
          score: p.score,
          isReady: p.isReady,
        })),
      },
      questionBank: {
        kd: {
          o24Questions: {
            multiplayer: kd.questions.multiplayer.map(kdToEditor),
            singleplayer: kd.questions.singleplayer.map((pool) => pool.map(kdToEditor)),
          },
        },
        vcnv: {
          questions: vcnvRows.map(vcnvToEditor),
          cnv: obstacle.answer,
          cnvMediaSrcNames:
            obstacle.imagePieceFiles?.length === VCNV_PIECE_COUNT
              ? [...obstacle.imagePieceFiles]
              : obstacle.imageFile
                ? [obstacle.imageFile]
                : [],
        },
        tt: { questions: tt.questions.map(ttToEditor) },
        vd: { questions: vd.questionPools.map((pool) => pool.map(vdToEditor)) },
        chp: {
          questions: chp.questions.map((q) => ({
            question: q.question,
            answer: q.answer,
            type: EditorQuestionType.Text,
            value: DEFAULT_GAME_RULES.chpCorrectPoints,
          })),
        },
      },
    };

    return editorData;
  }

  /** Referenced media as ordinary files for database-backed banks. */
  exportFiles(): { folder: MediaFolder; name: string; data: Buffer }[] {
    const vcnv = this.store.round('vcnv').get();
    const referenced = collectReferencedMedia({ kd: this.store.round('kd').get(), vcnv, tt: this.store.round('tt').get(), vd: this.store.round('vd').get() });
    const files: { folder: MediaFolder; name: string; data: Buffer }[] = [];
    const exportedVcnv = new Set<string>();
    for (const [folder, names] of referenced) for (const name of names) {
      const path = this.media.resolve(folder, name);
      if (path) {
        files.push({ folder, name, data: readFileSync(path) });
        if (folder === 'vcnv') exportedVcnv.add(name);
      }
    }
    if (vcnv.obstacle.imagePieceFiles?.length === VCNV_PIECE_COUNT) {
      for (const name of vcnv.obstacle.imagePieceFiles) {
        if (exportedVcnv.has(name)) continue;
        const path = this.media.resolveObstaclePiece(name);
        if (path) {
          files.push({ folder: 'vcnv', name, data: readFileSync(path) });
          exportedVcnv.add(name);
        }
      }
    }
    for (const name of new Set(Object.values(this.ui.get().miscImageSrcNames))) {
      const path = name ? this.media.resolve('misc', name) : undefined;
      if (path && name) files.push({ folder: 'misc', name, data: readFileSync(path) });
    }
    return files;
  }

  exportArchive(): { fileName: string; buffer: Buffer } {
    const editorData = this.exportData();
    const match = this.store.getMatch();
    const kd = this.store.round('kd').get();
    const vcnv = this.store.round('vcnv').get();
    const tt = this.store.round('tt').get();
    const vd = this.store.round('vd').get();
    const zip = new AdmZip();
    const ui = editorData.uiConfig as UiConfig;
    const addedMisc = new Set<string>();
    for (const slot of BRAND_SLOTS) {
      const name = ui.miscImageSrcNames[slot];
      const path = name ? this.media.resolve('misc', name) : undefined;
      if (path && name) {
        if (!addedMisc.has(name)) {
          zip.addLocalFile(path, 'misc', name);
          addedMisc.add(name);
        }
      } else {
        delete ui.miscImageSrcNames[slot];
      }
    }
    zip.addFile(EDITOR_DATA_ENTRY, Buffer.from(JSON.stringify(editorData)));
    this.addMediaFiles(zip, collectReferencedMedia({ kd, vcnv, tt, vd }), vcnv.obstacle.imagePieceFiles);

    const baseName = sanitizeFileName(match.matchName);
    const fileName = `${baseName === 'file' ? EXPORT_FALLBACK_NAME : baseName}.legion`;
    return { fileName, buffer: zip.toBuffer() };
  }

  // ------------------------------------------------------------------ media

  private addMediaFiles(
    zip: AdmZip,
    referenced: Map<RoundKind, Set<string>>,
    obstaclePieceFiles?: string[],
  ): void {
    const addedVcnv = new Set<string>();
    for (const [kind, names] of referenced) {
      for (const name of names) {
        const path = this.media.resolve(kind, name);
        if (path) {
          zip.addLocalFile(path, kind, name);
          if (kind === 'vcnv') addedVcnv.add(name);
        }
      }
    }
    if (obstaclePieceFiles?.length === VCNV_PIECE_COUNT) {
      for (const name of obstaclePieceFiles) {
        if (addedVcnv.has(name)) continue;
        const path = this.media.resolveObstaclePiece(name);
        if (path) {
          zip.addLocalFile(path, 'vcnv', name);
          addedVcnv.add(name);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// editorData parsing
// ---------------------------------------------------------------------------

/** Validate an archive and return its match name without writing any files. */
export async function inspectLegionArchive(buffer: Buffer): Promise<{ matchName: string }> {
  const { editorData } = await parseArchiveAsync(buffer);
  return { matchName: editorData.matchData.matchName ?? '' };
}

function mapArchiveError(code: ArchiveErrorCode, message: string): Error {
  switch (code) {
    case 'QUOTA':
      return new QuotaError();
    case 'LIMIT':
      return new ArchiveLimitError(message);
    case 'MEDIA':
      return new UnsupportedMediaError(message);
    default:
      return new Error(message);
  }
}

async function runArchiveWorker(
  buffer: Buffer,
  options: { maxMediaBytes?: number },
): Promise<ParsedArchive> {
  const workerPath = join(__dirname, 'archive-worker.js');
  if (!existsSync(workerPath)) {
    try {
      return parseArchiveBuffer(buffer, options);
    } catch (err) {
      if (err instanceof ArchiveParseError) throw mapArchiveError(err.code, err.message);
      throw err;
    }
  }
  return new Promise<ParsedArchive>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        buffer,
        maxMediaBytes: options.maxMediaBytes,
      },
    });
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    worker.once('message', (msg: { ok: true; result: ParsedArchive } | { ok: false; code: ArchiveErrorCode; message: string }) => {
      done(() => {
        if (msg.ok) resolve(msg.result);
        else reject(mapArchiveError(msg.code, msg.message));
      });
    });
    worker.once('error', (err) => done(() => reject(err)));
    worker.once('exit', (code) => {
      if (code !== 0) done(() => reject(new Error(`Archive worker exited with code ${code}`)));
    });
  });
}

export async function parseArchiveAsync(
  buffer: Buffer,
  options: { maxMediaBytes?: number } = {},
): Promise<{ editorData: EditorData; files: { folder: MediaFolder; name: string; data: Buffer }[]; totalMediaBytes: number }> {
  if (activeArchiveImports >= MAX_CONCURRENT_ARCHIVE_IMPORTS) {
    throw new ArchiveBusyError();
  }
  activeArchiveImports += 1;
  try {
    const parsed = await runArchiveWorker(buffer, options);
    const editorData = parsed.editorData as EditorData;
    const bank = editorData.questionBank;
    mapKdRound(bank.kd);
    mapVcnvRound(bank.vcnv);
    mapTtRound(bank.tt?.questions ?? []);
    mapVdRound(bank.vd?.questions ?? []);
    mapChpRound(bank.chp?.questions ?? []);
    if (typeof editorData.matchData?.matchName !== 'string' || !Array.isArray(editorData.matchData?.players)) {
      throw new Error('Invalid .legion file: invalid match data');
    }
    const files = parsed.files.map((f) => ({
      folder: f.folder as MediaFolder,
      name: f.name,
      data: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength),
    }));
    return { editorData, files, totalMediaBytes: parsed.totalMediaBytes };
  } finally {
    activeArchiveImports -= 1;
  }
}

// ---------------------------------------------------------------------------
// Editor question bank → canonical rounds
// ---------------------------------------------------------------------------

type MediaNameResolver = (folder: MediaFolder, name: string | undefined) => string | undefined;
const identityMediaResolver: MediaNameResolver = (_folder, name) => name;

function mapKdRound(
  src: EditorKdQuestionData | undefined,
  resolveMedia: MediaNameResolver = identityMediaResolver,
): KdRound {
  const { singleplayer, multiplayer } = splitKdPools(src);
  return {
    questions: {
      singleplayer: singleplayer.map((pool) => pool.map((q) => editorToKd(q, resolveMedia))),
      multiplayer: multiplayer.map((q) => editorToKd(q, resolveMedia)),
    },
    gamemode: 'S',
    activePlayerIndex: 0,
  };
}

/**
 * The editor keys o24Questions by its O24ControlType enum, whose runtime
 * values are not part of this repo. Prefer o23Questions and the literal
 * singleplayer/multiplayer keys, then fall back to detecting each pool by
 * shape (singleplayer is a nested array, multiplayer is flat).
 */
function splitKdPools(src: EditorKdQuestionData | undefined): {
  singleplayer: EditorQuestion[][];
  multiplayer: EditorQuestion[];
} {
  let singleplayer: EditorQuestion[][] | undefined = src?.o23Questions;
  let multiplayer: EditorQuestion[] | undefined;
  for (const [key, pool] of Object.entries(src?.o24Questions ?? {})) {
    if (!Array.isArray(pool)) continue;
    const isNested = pool.length > 0 && Array.isArray(pool[0]);
    if (key === 'singleplayer' || (key !== 'multiplayer' && isNested)) {
      singleplayer ??= pool as EditorQuestion[][];
    } else {
      multiplayer ??= pool as EditorQuestion[];
    }
  }
  return { singleplayer: singleplayer ?? [], multiplayer: multiplayer ?? [] };
}

function editorToKd(q: EditorQuestion, resolveMedia: MediaNameResolver): KdQuestion {
  const mediaFile = resolveMedia('kd', q.mediaSrcName);
  return {
    question: q.question,
    answer: q.answer,
    type: KD_TYPE_BY_EDITOR[q.type] ?? 'N',
    ...(mediaFile ? { mediaFile } : {}),
  };
}

function mapVcnvRound(
  src: EditorVcnvQuestionData | undefined,
  obstaclePieceFiles?: string[],
  resolveMedia: MediaNameResolver = identityMediaResolver,
): VcnvRound {
  const rows = (src?.questions ?? [])
    .slice(0, VCNV_ROW_COUNT)
    .map((q, index): VcnvQuestion => {
      const imageFile = resolveMedia('vcnv', q.mediaSrcName);
      return {
        id: index + 1,
        type: 'HN',
        value: DEFAULT_GAME_RULES.vcnvRowPoints,
        isOpen: false,
        isShown: false,
        question: q.question,
        answer: q.answer,
        ...(imageFile ? { imageFile } : {}),
      };
    });
  const hasProtectedPieces = obstaclePieceFiles?.length === VCNV_PIECE_COUNT;
  const obstacleImage = hasProtectedPieces ? undefined : resolveMedia('vcnv', src?.cnvMediaSrcNames?.[0]);
  const obstacle: VcnvObstacle = {
    value: DEFAULT_GAME_RULES.obstacleValueByRevealedCount[0],
    question: '',
    answer: src?.cnv ?? '',
    ...(obstacleImage ? { imageFile: obstacleImage } : {}),
    ...(hasProtectedPieces ? { imagePieceFiles: obstaclePieceFiles } : {}),
  };
  return {
    questions: rows,
    obstacle,
    playerAnswers: Array.from({ length: PLAYER_COUNT }, () => ({
      answer: '',
      correct: false,
    })),
    showResults: false,
    disabledPlayers: [],
    openRowCount: 0,
    obstacleBuzzes: [],
  };
}

function mapTtRound(
  questions: EditorQuestion[],
  resolveMedia: MediaNameResolver = identityMediaResolver,
): TtRound {
  return {
    questions: questions.map((q, index): TtQuestion => {
      const base = { id: index + 1, question: q.question, answer: q.answer };
      const primary = resolveMedia('tt', q.mediaSrcName);
      const secondary = resolveMedia('tt', q.secondaryMediaSrcName);
      if (q.type === EditorQuestionType.Video) {
        return {
          ...base,
          type: 'video',
          ...(primary ? { videoFile: primary } : {}),
          ...(secondary ? { answerImage: secondary } : {}),
        };
      }
      return {
        ...base,
        type: 'image',
        ...(primary ? { questionImage: primary } : {}),
        ...(secondary ? { answerImage: secondary } : {}),
      };
    }),
    playerAnswers: Array.from({ length: PLAYER_COUNT }, (_, playerIndex) => ({
      playerIndex,
      answer: '',
      timestamp: 0,
      readableTime: '',
      correct: false,
    })),
    showResults: false,
    activeQuestionIndex: NO_ACTIVE_QUESTION,
    showAnswer: false,
    timerStartTimestamp: 0,
  };
}

function mapVdRound(
  pools: EditorQuestion[][],
  resolveMedia: MediaNameResolver = identityMediaResolver,
): VdRound {
  return {
    questionPools: pools.map((pool) =>
      pool.map((q): VdQuestion => {
        const mediaFile = resolveMedia('vd', q.mediaSrcName);
        return {
          value: q.value,
          type: VD_TYPE_BY_EDITOR[q.type] ?? 'N',
          question: q.question,
          answer: q.answer,
          ...(mediaFile ? { mediaFile } : {}),
        };
      }),
    ),
    activePlayerIndex: 0,
    isQuestionPickerShown: false,
    pickedQuestions: [],
    hopeStarActive: false,
  };
}

function mapChpRound(questions: EditorQuestion[]): ChpRound {
  return {
    questions: questions.map((q) => ({ question: q.question, answer: q.answer })),
    playedPlayers: Array.from({ length: PLAYER_COUNT }, () => false),
  };
}

// ---------------------------------------------------------------------------
// Canonical rounds → editor question bank (export)
// ---------------------------------------------------------------------------

function kdToEditor(q: KdQuestion): EditorQuestion {
  return {
    question: q.question,
    answer: q.answer,
    type: EDITOR_TYPE_BY_KD[q.type] ?? EditorQuestionType.Text,
    value: DEFAULT_GAME_RULES.kdCorrectPoints,
    ...(q.mediaFile ? { mediaSrcName: q.mediaFile } : {}),
  };
}

function vcnvToEditor(q: VcnvQuestion): EditorQuestion {
  const mediaName = q.imageFile ?? q.audioFile;
  const type = q.imageFile
    ? EditorQuestionType.Image
    : q.audioFile
      ? EditorQuestionType.Audio
      : EditorQuestionType.Text;
  return {
    question: q.question,
    answer: q.answer,
    type,
    value: q.value,
    ...(mediaName ? { mediaSrcName: mediaName } : {}),
  };
}

function ttToEditor(q: TtQuestion): EditorQuestion {
  const mediaName = q.type === 'video' ? q.videoFile : q.questionImage;
  return {
    question: q.question,
    answer: q.answer,
    type: q.type === 'video' ? EditorQuestionType.Video : EditorQuestionType.Image,
    value: NO_STATIC_VALUE,
    ...(mediaName ? { mediaSrcName: mediaName } : {}),
    ...(q.answerImage ? { secondaryMediaSrcName: q.answerImage } : {}),
  };
}

function vdToEditor(q: VdQuestion): EditorQuestion {
  return {
    question: q.question,
    answer: q.answer,
    type: EDITOR_TYPE_BY_VD[q.type] ?? EditorQuestionType.Text,
    value: q.value,
    ...(q.mediaFile ? { mediaSrcName: q.mediaFile } : {}),
  };
}

// ---------------------------------------------------------------------------
// Media reference collection (export)
// ---------------------------------------------------------------------------

function collectReferencedMedia(rounds: {
  kd: KdRound;
  vcnv: VcnvRound;
  tt: TtRound;
  vd: VdRound;
}): Map<RoundKind, Set<string>> {
  const referenced = new Map<RoundKind, Set<string>>();
  const add = (kind: RoundKind, name: string | undefined): void => {
    if (!name) return;
    const names = referenced.get(kind) ?? new Set<string>();
    names.add(name);
    referenced.set(kind, names);
  };

  for (const pool of rounds.kd.questions.singleplayer) {
    for (const q of pool) add('kd', q.mediaFile);
  }
  for (const q of rounds.kd.questions.multiplayer) add('kd', q.mediaFile);
  for (const q of rounds.vcnv.questions) {
    add('vcnv', q.imageFile);
    add('vcnv', q.audioFile);
  }
  add('vcnv', rounds.vcnv.obstacle.imageFile);
  for (const q of rounds.tt.questions) {
    add('tt', q.questionImage);
    add('tt', q.answerImage);
    add('tt', q.videoFile);
  }
  for (const pool of rounds.vd.questionPools) {
    for (const q of pool) add('vd', q.mediaFile);
  }
  return referenced;
}
