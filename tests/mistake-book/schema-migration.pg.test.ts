/**
 * C3 §3 — synthetic OLD server schemas migrate preserving everything.
 *
 * Every case runs in its OWN UNIQUE SYNTHETIC SCHEMA on the isolated real
 * PostgreSQL instance: an admin connection only CREATE/DROPs that named
 * schema; a separate pinned pool sets `search_path` to it per connection, so
 * public tables used by the other required-PG suites are never touched.
 *
 * Fixture provenance: the "legacy" course rows are REAL DSL envelopes — a
 * valid document is written by the production PgDocumentStore into a
 * throwaway schema, its raw rows are transplanted into the old-shape tables,
 * and the production reader proves readability after migration. Migration is
 * the PRODUCTION ensure functions; idempotence is a full before/after schema
 * snapshot comparison.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeDocument as sdkMakeDocument } from '../../packages/@openmaic/storage/test/document-contract';

const contractUrl = process.env.PG_CONTRACT_URL;

describe.skipIf(!contractUrl)('old server schema migration (own synthetic schema, real PG)', () => {
  type Queryable = {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  type PoolLike = Queryable & {
    connect(): Promise<
      Queryable & { query(text: string, params?: unknown[]): Promise<unknown>; release(): void }
    >;
    end(): Promise<void>;
  };
  let Pool: new (config: { connectionString: string; max?: number; options?: string }) => PoolLike;
  let admin: PoolLike;
  let worker: PoolLike;
  let ensureMistakeBookSchema: (q: Queryable) => Promise<void>;
  let ensureDocumentSchema: (q: Queryable) => Promise<void>;
  let ensureAssetSchema: (q: Queryable) => Promise<void>;
  let PgDocumentStore: new (
    queryable: Queryable,
    options: {
      withTransaction: <T>(body: (q: Queryable) => Promise<T>) => Promise<T>;
    },
  ) => {
    saveDocument(doc: unknown): Promise<void>;
    loadDocument(stageId: string): Promise<unknown>;
  };
  const schemaNames: string[] = [];

  const tableNames = [
    'mistake_record',
    'mistake_capture_event',
    'mistake_classification',
    'document_folders',
    'document_stages',
    'document_scenes',
    'document_outlines',
    'document_stage_revision',
    'document_scene_revision',
    'asset_blobs',
    'asset_entries',
    'document_asset_refs',
  ];

  beforeAll(async () => {
    const pg = await import('pg');
    Pool = pg.Pool as never;
    const persistence = await import('@/lib/persistence/mistake-book');
    ensureMistakeBookSchema = persistence.ensureMistakeBookSchema as never;
    const documentModule = (await import('@openmaic/storage/document/pg')) as {
      ensureDocumentSchema: (q: Queryable) => Promise<void>;
      PgDocumentStore: typeof PgDocumentStore;
    };
    ensureDocumentSchema = documentModule.ensureDocumentSchema;
    PgDocumentStore = documentModule.PgDocumentStore;
    const assetModule = (await import('@openmaic/storage/asset/pg')) as {
      ensureAssetSchema: (q: Queryable) => Promise<void>;
    };
    ensureAssetSchema = assetModule.ensureAssetSchema;
    admin = new Pool({ connectionString: contractUrl!, max: 2 });
  });

  afterAll(async () => {
    for (const schema of schemaNames) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    }
    await worker?.end().catch(() => undefined);
    await admin.end();
  });

  /** Create a unique synthetic schema and pin a worker pool to it. */
  async function newSyntheticSchema(label: string): Promise<string> {
    const schema = `c3mig_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    schemaNames.push(schema);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await worker?.end().catch(() => undefined);
    worker = new Pool({
      connectionString: contractUrl!,
      max: 4,
      options: `-c search_path=${schema}`, // per-connection, this schema only
    });
    return schema;
  }

  const dropFixtureTables = async (): Promise<void> => {
    await worker.query(`DROP TABLE IF EXISTS ${tableNames.join(', ')} CASCADE`);
  };

  const snapshot = async (): Promise<Record<string, unknown[]>> => {
    const result: Record<string, unknown[]> = {};
    for (const table of tableNames) {
      const exists = await worker.query(`SELECT to_regclass($1) AS reg`, [table]);
      if (!exists.rows[0]!.reg) continue;
      const rows = await worker.query(`SELECT * FROM ${table}`);
      result[table] = [...rows.rows].sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
      );
    }
    return result;
  };

  /** A pinned per-call transaction hook over the worker pool. */
  const workerTransaction = async <T>(body: (q: Queryable) => Promise<T>): Promise<T> => {
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client as Queryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  /**
   * REAL legacy DSL rows: save a valid document through the production
   * PgDocumentStore into a THROWAWAY schema, then read its raw rows back.
   */
  async function realDocumentRows(): Promise<{
    stageData: unknown;
    sceneData: Array<{ id: string; sceneOrder: number; data: unknown }>;
    outlineData: unknown;
    stageId: string;
  }> {
    const scratch = `c3mig_scratch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    schemaNames.push(scratch);
    await admin.query(`CREATE SCHEMA ${scratch}`);
    const scratchPool = new Pool({
      connectionString: contractUrl!,
      max: 2,
      options: `-c search_path=${scratch}`,
    });
    try {
      await ensureDocumentSchema(scratchPool);
      const store = new PgDocumentStore(scratchPool, {
        withTransaction: (body) =>
          scratchPool.connect().then(async (client) => {
            try {
              await client.query('BEGIN');
              const result = await body(client as Queryable);
              await client.query('COMMIT');
              return result;
            } catch (error) {
              await client.query('ROLLBACK').catch(() => undefined);
              throw error;
            } finally {
              client.release();
            }
          }),
      });
      const doc = sdkMakeDocument('stage-legacy');
      await store.saveDocument(doc);
      const stage = (
        await scratchPool.query(`SELECT * FROM document_stages WHERE id = 'stage-legacy'`)
      ).rows[0]!;
      const scenes = (
        await scratchPool.query(
          `SELECT id, scene_order, data FROM document_scenes WHERE stage_id = 'stage-legacy' ORDER BY scene_order`,
        )
      ).rows;
      const outline = (
        await scratchPool.query(
          `SELECT data FROM document_outlines WHERE stage_id = 'stage-legacy'`,
        )
      ).rows[0]!;
      return {
        stageData: stage.data,
        sceneData: scenes.map((row) => ({
          id: String(row.id),
          sceneOrder: Number(row.scene_order),
          data: row.data,
        })),
        outlineData: outline.data,
        stageId: 'stage-legacy',
      };
    } finally {
      await scratchPool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`).catch(() => undefined);
    }
  }

  /** The pre-taxonomy mistake table (no classification/event-id columns). */
  async function buildOldMistakeTable(): Promise<void> {
    await worker.query(`
      CREATE TABLE mistake_record (
        owner_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        scene_title TEXT,
        scene_order INTEGER,
        question_type TEXT NOT NULL,
        question TEXT NOT NULL,
        options JSONB,
        correct_answer JSONB,
        analysis TEXT,
        last_user_answer JSONB NOT NULL,
        wrong_count INTEGER NOT NULL DEFAULT 1,
        first_wrong_at DOUBLE PRECISION NOT NULL,
        last_wrong_at DOUBLE PRECISION NOT NULL,
        mastered_at DOUBLE PRECISION,
        PRIMARY KEY (owner_id, stage_id, scene_id, question_id)
      )`);
  }

  const mistakeRows = [
    {
      owner_id: 'owner-old-a',
      stage_id: 'stage-old',
      scene_id: 'scene-1',
      question_id: 'q1',
      stage_name: '旧课程',
      scene_title: '第一课',
      scene_order: 3,
      question_type: 'single',
      question: '1+1=?',
      options: [{ label: '2', value: 'A' }] as unknown,
      correct_answer: ['A'] as unknown,
      analysis: 'basic',
      last_user_answer: { value: 'B' } as unknown,
      wrong_count: 4,
      first_wrong_at: 1_000.5,
      last_wrong_at: 9_000.25,
      mastered_at: null,
    },
    {
      owner_id: 'owner-old-b',
      stage_id: 'stage-old',
      scene_id: 'scene-1',
      question_id: 'q1',
      stage_name: '旧课程',
      scene_title: '第一课',
      scene_order: 3,
      question_type: 'short_answer',
      question: 'explain',
      options: null,
      correct_answer: null,
      analysis: null,
      last_user_answer: { text: '因为' } as unknown,
      wrong_count: 2,
      first_wrong_at: 2_000,
      last_wrong_at: 8_000,
      mastered_at: 8_500,
    },
    {
      owner_id: 'owner-old-a',
      stage_id: 'stage-other',
      scene_id: 'scene-9',
      question_id: 'q9',
      stage_name: '另一门',
      scene_title: null,
      scene_order: null,
      question_type: 'multiple',
      question: 'pick',
      options: [] as unknown,
      correct_answer: ['A', 'B'] as unknown,
      analysis: 'multi',
      last_user_answer: { value: ['A'] } as unknown,
      wrong_count: 1,
      first_wrong_at: 3_000,
      last_wrong_at: 3_000,
      mastered_at: null,
    },
  ];

  async function seedMistakeRows(): Promise<void> {
    for (const row of mistakeRows) {
      await worker.query(
        `INSERT INTO mistake_record
           (owner_id, stage_id, scene_id, question_id, stage_name, scene_title,
            scene_order, question_type, question, options, correct_answer,
            analysis, last_user_answer, wrong_count, first_wrong_at,
            last_wrong_at, mastered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,
                 $14,$15,$16,$17)`,
        [
          row.owner_id,
          row.stage_id,
          row.scene_id,
          row.question_id,
          row.stage_name,
          row.scene_title,
          row.scene_order,
          row.question_type,
          row.question,
          JSON.stringify(row.options ?? null),
          JSON.stringify(row.correct_answer ?? null),
          row.analysis,
          JSON.stringify(row.last_user_answer),
          row.wrong_count,
          row.first_wrong_at,
          row.last_wrong_at,
          row.mastered_at,
        ],
      );
    }
  }

  it('PURE-OLD shapes: first upgrade adds everything, preserves every field, reader loads the real legacy course, second upgrade changes nothing', async () => {
    await newSyntheticSchema('pureold');
    try {
      await dropFixtureTables();
      await buildOldMistakeTable();
      await seedMistakeRows();

      // Pre-owner course tables with REAL legacy DSL data.
      const legacy = await realDocumentRows();
      await worker.query(`
        CREATE TABLE document_stages (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          interactive_mode BOOLEAN,
          task_engine_mode BOOLEAN,
          created_at DOUBLE PRECISION NOT NULL,
          updated_at DOUBLE PRECISION NOT NULL,
          data JSONB NOT NULL
        )`);
      await worker.query(`
        CREATE TABLE document_scenes (
          stage_id TEXT NOT NULL,
          id TEXT NOT NULL,
          scene_order INTEGER NOT NULL,
          data JSONB NOT NULL,
          PRIMARY KEY (stage_id, id)
        )`);
      await worker.query(`
        CREATE TABLE document_outlines (
          stage_id TEXT PRIMARY KEY,
          data JSONB NOT NULL
        )`);
      const stageEnvelope = legacy.stageData as Record<string, unknown>;
      await worker.query(
        `INSERT INTO document_stages
           (id, name, description, interactive_mode, task_engine_mode,
            created_at, updated_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          legacy.stageId,
          String(stageEnvelope.name),
          null,
          null,
          null,
          Number(stageEnvelope.createdAt),
          Number(stageEnvelope.updatedAt),
          JSON.stringify(stageEnvelope),
        ],
      );
      for (const scene of legacy.sceneData) {
        await worker.query(
          `INSERT INTO document_scenes (stage_id, id, scene_order, data)
           VALUES ($1,$2,$3,$4::jsonb)`,
          [legacy.stageId, scene.id, scene.sceneOrder, JSON.stringify(scene.data)],
        );
      }
      await worker.query(`INSERT INTO document_outlines (stage_id, data) VALUES ($1,$2::jsonb)`, [
        legacy.stageId,
        JSON.stringify(legacy.outlineData),
      ]);

      // Pre-TTL asset tables with rows.
      await worker.query(`
        CREATE TABLE asset_blobs (
          content_hash TEXT PRIMARY KEY,
          byte_size BIGINT NOT NULL,
          bytes BYTEA,
          unreferenced_at TIMESTAMPTZ
        )`);
      await worker.query(`
        CREATE TABLE asset_entries (
          id TEXT PRIMARY KEY,
          principal TEXT NOT NULL,
          content_hash TEXT NOT NULL REFERENCES asset_blobs(content_hash),
          mime TEXT NOT NULL,
          meta JSONB NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at DOUBLE PRECISION NOT NULL
        )`);
      await worker.query(
        `INSERT INTO asset_blobs (content_hash, byte_size, bytes) VALUES ($1,$2,$3)`,
        ['hash-old', 4, Buffer.from([1, 2, 3, 4])],
      );
      await worker.query(
        `INSERT INTO asset_entries (id, principal, content_hash, mime, meta, revision, created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        ['ast-old-1', 'owner-old-a', 'hash-old', 'image/png', JSON.stringify({ w: 1 }), 2, 5_000],
      );

      // ── FIRST UPGRADE: the production ensure functions.
      await ensureMistakeBookSchema(worker);
      await ensureDocumentSchema(worker);
      await ensureAssetSchema(worker);

      // Columns/tables added; classification stays NULL (unclassified).
      const columns = await worker.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'mistake_record'`,
      );
      const names = columns.rows.map((row) => row.column_name);
      for (const added of ['subject', 'grade_semester', 'last_event_id']) {
        expect(names).toContain(added);
      }
      for (const table of ['mistake_capture_event', 'mistake_classification']) {
        const exists = await worker.query(`SELECT to_regclass($1) AS reg`, [table]);
        expect(exists.rows[0]!.reg).not.toBeNull();
      }

      // Every seeded mistake row survives field-for-field under its owner key.
      const migrated = await worker.query(
        `SELECT * FROM mistake_record ORDER BY owner_id, stage_id, question_id`,
      );
      expect(migrated.rows).toHaveLength(3);
      const byOwner = new Map(
        migrated.rows.map((row) => [`${row.owner_id}:${row.question_id}`, row]),
      );
      const a1 = byOwner.get('owner-old-a:q1')!;
      expect(a1).toMatchObject({
        stage_id: 'stage-old',
        scene_title: '第一课',
        scene_order: 3,
        question_type: 'single',
        question: '1+1=?',
        wrong_count: 4,
        first_wrong_at: 1_000.5,
        last_wrong_at: 9_000.25,
        mastered_at: null,
        subject: null,
        grade_semester: null,
        last_event_id: null,
      });
      expect(a1.options).toEqual([{ label: '2', value: 'A' }]);
      expect(a1.correct_answer).toEqual(['A']);
      expect(a1.last_user_answer).toEqual({ value: 'B' });
      expect(byOwner.get('owner-old-b:q1')!).toMatchObject({
        wrong_count: 2,
        mastered_at: 8_500,
      });
      expect(byOwner.get('owner-old-b:q1')!.last_user_answer).toEqual({ text: '因为' });
      expect(byOwner.get('owner-old-a:q9')!).toMatchObject({
        wrong_count: 1,
        stage_id: 'stage-other',
      });

      // PRODUCTION SDK READER: the real legacy course loads intact after
      // the upgrade (ensure + PgDocumentStore reader coverage; the
      // APPLICATION provider bootstrap is proven by the third case below).
      const reader = new PgDocumentStore(worker, { withTransaction: workerTransaction });
      const loaded = (await reader.loadDocument(legacy.stageId)) as {
        stage: { id: string; name: string };
        scenes: Array<{ id: string }>;
      } | null;
      expect(loaded).not.toBeNull();
      expect(loaded!.stage).toMatchObject({ id: 'stage-legacy', name: 'Intro Course' });
      expect(loaded!.scenes.map((scene) => scene.id)).toEqual(['scene-a', 'scene-b']);

      // Asset rows preserved with the new TTL columns NULL.
      const entry = (await worker.query(`SELECT * FROM asset_entries`)).rows[0]!;
      expect(entry).toMatchObject({
        id: 'ast-old-1',
        principal: 'owner-old-a',
        revision: 2,
        committed_at: null,
        expires_at: null,
        unreferenced_at: null,
      });
      expect(entry.meta).toEqual({ w: 1 });
      const blob = (await worker.query(`SELECT * FROM asset_blobs`)).rows[0]!;
      expect(Number(blob.byte_size)).toBe(4);
      expect(blob.bytes).toEqual(Buffer.from([1, 2, 3, 4]));
      // The new refs table works for a fresh synthetic reference.
      await worker.query(
        `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
         VALUES ('stage-legacy', 'stage', '', 'ast-old-1')`,
      );
      const ref = (await worker.query(`SELECT * FROM document_asset_refs`)).rows[0]!;
      expect(ref).toMatchObject({ stage_id: 'stage-legacy', asset_id: 'ast-old-1' });

      // Manual classification authority survives every later ensure.
      await worker.query(
        `INSERT INTO mistake_classification
           (owner_id, stage_id, subject, grade_semester, source, updated_at)
         VALUES ('owner-old-a', 'stage-old', 'math', 'grade-1-up', 'manual', 7_777)`,
      );

      // ── SECOND UPGRADE: idempotent — the whole schema snapshot is equal.
      const before = await snapshot();
      await ensureMistakeBookSchema(worker);
      await ensureDocumentSchema(worker);
      await ensureAssetSchema(worker);
      expect(await snapshot()).toEqual(before);
    } finally {
      await dropFixtureTables().catch(() => undefined);
    }
  });

  it('PARTIAL-UPGRADE database: revisions, asset refs, manual authority, and owner-scoped rows seeded BEFORE the first tested upgrade all survive it field-for-field, then idempotence', async () => {
    await newSyntheticSchema('partial');
    try {
      await dropFixtureTables();
      // A partially-migrated shape: mistake table already has classification
      // columns; revisions/refs/classification tables exist WITH real rows.
      await buildOldMistakeTable();
      await worker.query(
        `ALTER TABLE mistake_record ADD COLUMN subject TEXT, ADD COLUMN grade_semester TEXT, ADD COLUMN last_event_id TEXT`,
      );
      await worker.query(`
        CREATE TABLE mistake_capture_event (
          owner_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          captured_at DOUBLE PRECISION NOT NULL,
          PRIMARY KEY (owner_id, event_id)
        )`);
      await worker.query(`
        CREATE TABLE mistake_classification (
          owner_id TEXT NOT NULL,
          stage_id TEXT NOT NULL,
          subject TEXT,
          grade_semester TEXT,
          source TEXT NOT NULL,
          updated_at DOUBLE PRECISION NOT NULL,
          PRIMARY KEY (owner_id, stage_id)
        )`);
      await seedMistakeRows();
      await worker.query(
        `UPDATE mistake_record SET subject = 'math', grade_semester = 'grade-2-up', last_event_id = 'ev-legacy-1'
          WHERE owner_id = 'owner-old-a' AND question_id = 'q1'`,
      );
      await worker.query(
        `INSERT INTO mistake_capture_event VALUES ('owner-old-a', 'ev-legacy-1', 'hash-legacy-1', 4444)`,
      );
      // MANUAL authority — a decision, never to be downgraded by migration.
      await worker.query(
        `INSERT INTO mistake_classification
           VALUES ('owner-old-b', 'stage-old', 'english', 'grade-3-up', 'manual', 6666)`,
      );

      // OWNER-SCOPED course with revisions, scenes, outline (real DSL rows).
      const legacy = await realDocumentRows();
      await worker.query(`
        CREATE TABLE document_stages (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          interactive_mode BOOLEAN,
          task_engine_mode BOOLEAN,
          created_at DOUBLE PRECISION NOT NULL,
          updated_at DOUBLE PRECISION NOT NULL,
          owner_id TEXT,
          folder_id TEXT,
          data JSONB NOT NULL
        )`);
      await worker.query(`
        CREATE TABLE document_scenes (
          stage_id TEXT NOT NULL,
          id TEXT NOT NULL,
          scene_order INTEGER NOT NULL,
          data JSONB NOT NULL,
          PRIMARY KEY (stage_id, id)
        )`);
      await worker.query(`
        CREATE TABLE document_outlines (stage_id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
      await worker.query(`
        CREATE TABLE document_stage_revision (stage_id TEXT PRIMARY KEY, rev BIGINT NOT NULL)`);
      await worker.query(`
        CREATE TABLE document_scene_revision (
          stage_id TEXT NOT NULL,
          scene_id TEXT NOT NULL,
          rev BIGINT NOT NULL,
          PRIMARY KEY (stage_id, scene_id)
        )`);
      const stageEnvelope = legacy.stageData as Record<string, unknown>;
      await worker.query(
        `INSERT INTO document_stages
           (id, name, description, interactive_mode, task_engine_mode,
            created_at, updated_at, owner_id, folder_id, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          legacy.stageId,
          String(stageEnvelope.name),
          null,
          null,
          null,
          Number(stageEnvelope.createdAt),
          Number(stageEnvelope.updatedAt),
          'owner-old-b', // owner-scoped BEFORE the tested upgrade
          null,
          JSON.stringify(stageEnvelope),
        ],
      );
      for (const scene of legacy.sceneData) {
        await worker.query(
          `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1,$2,$3,$4::jsonb)`,
          [legacy.stageId, scene.id, scene.sceneOrder, JSON.stringify(scene.data)],
        );
      }
      await worker.query(`INSERT INTO document_outlines VALUES ($1,$2::jsonb)`, [
        legacy.stageId,
        JSON.stringify(legacy.outlineData),
      ]);
      await worker.query(`INSERT INTO document_stage_revision VALUES ($1, $2)`, [
        legacy.stageId,
        42,
      ]);
      for (const scene of legacy.sceneData) {
        await worker.query(`INSERT INTO document_scene_revision VALUES ($1, $2, $3)`, [
          legacy.stageId,
          scene.id,
          7,
        ]);
      }

      // Asset tables WITH TTL columns and a course-level reference, all
      // seeded BEFORE the tested upgrade.
      await worker.query(`
        CREATE TABLE asset_blobs (
          content_hash TEXT PRIMARY KEY,
          byte_size BIGINT NOT NULL,
          bytes BYTEA,
          unreferenced_at TIMESTAMPTZ
        )`);
      await worker.query(`
        CREATE TABLE asset_entries (
          id TEXT PRIMARY KEY,
          principal TEXT NOT NULL,
          content_hash TEXT NOT NULL REFERENCES asset_blobs(content_hash),
          mime TEXT NOT NULL,
          meta JSONB NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at DOUBLE PRECISION NOT NULL,
          committed_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ,
          unreferenced_at TIMESTAMPTZ
        )`);
      await worker.query(`
        CREATE TABLE document_asset_refs (
          stage_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          scene_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          PRIMARY KEY (stage_id, scope, scene_id, asset_id)
        )`);
      await worker.query(`INSERT INTO asset_blobs VALUES ('hash-partial', 2, $1, NULL)`, [
        Buffer.from([9, 9]),
      ]);
      await worker.query(
        `INSERT INTO asset_entries
           (id, principal, content_hash, mime, meta, revision, created_at, committed_at)
         VALUES ('ast-partial', 'owner-old-b', 'hash-partial', 'image/png', $1::jsonb, 1, 100, '2026-01-01T00:00:00Z')`,
        [JSON.stringify({ h: 2 })],
      );
      await worker.query(
        `INSERT INTO document_asset_refs VALUES ('stage-legacy', 'scene', 'scene-a', 'ast-partial')`,
      );

      // ── The FIRST TESTED UPGRADE.
      await ensureMistakeBookSchema(worker);
      await ensureDocumentSchema(worker);
      await ensureAssetSchema(worker);

      // Every pre-existing FACT survived field-for-field.
      const event = (await worker.query(`SELECT * FROM mistake_capture_event`)).rows[0]!;
      expect(event).toMatchObject({
        owner_id: 'owner-old-a',
        event_id: 'ev-legacy-1',
        payload_hash: 'hash-legacy-1',
        captured_at: 4_444,
      });
      const authority = (await worker.query(`SELECT * FROM mistake_classification`)).rows[0]!;
      expect(authority).toEqual({
        owner_id: 'owner-old-b',
        stage_id: 'stage-old',
        subject: 'english',
        grade_semester: 'grade-3-up',
        source: 'manual',
        updated_at: 6_666,
      });
      const classified = (
        await worker.query(
          `SELECT subject, grade_semester, last_event_id FROM mistake_record
            WHERE owner_id = 'owner-old-a' AND question_id = 'q1'`,
        )
      ).rows[0]!;
      expect(classified).toEqual({
        subject: 'math',
        grade_semester: 'grade-2-up',
        last_event_id: 'ev-legacy-1',
      });
      const stageRev = (await worker.query(`SELECT * FROM document_stage_revision`)).rows[0]!;
      expect(Number(stageRev.rev)).toBe(42);
      const sceneRevs = await worker.query(`SELECT * FROM document_scene_revision`);
      expect(sceneRevs.rows.map((row) => [row.scene_id, Number(row.rev)]).sort()).toEqual([
        ['scene-a', 7],
        ['scene-b', 7],
      ]);
      const refs = (await worker.query(`SELECT * FROM document_asset_refs`)).rows;
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({
        stage_id: 'stage-legacy',
        scope: 'scene',
        scene_id: 'scene-a',
        asset_id: 'ast-partial',
      });
      const ttlEntry = (await worker.query(`SELECT * FROM asset_entries`)).rows[0]!;
      expect(ttlEntry).toMatchObject({
        id: 'ast-partial',
        principal: 'owner-old-b',
        // TIMESTAMPTZ round-trips as a JS Date from this driver: assert the
        // exact instant, not the serialization.
        committed_at: new Date('2026-01-01T00:00:00.000Z'),
        expires_at: null,
        unreferenced_at: null,
      });

      // PRODUCTION SDK READER over the upgraded partial database.
      const reader = new PgDocumentStore(worker, { withTransaction: workerTransaction });
      const loaded = (await reader.loadDocument(legacy.stageId)) as {
        stage: { id: string };
        scenes: Array<{ id: string }>;
      } | null;
      expect(loaded).not.toBeNull();
      expect(loaded!.scenes.map((scene) => scene.id)).toEqual(['scene-a', 'scene-b']);

      // ── IDEMPOTENCE.
      const before = await snapshot();
      await ensureMistakeBookSchema(worker);
      await ensureDocumentSchema(worker);
      await ensureAssetSchema(worker);
      expect(await snapshot()).toEqual(before);
    } finally {
      await dropFixtureTables().catch(() => undefined);
    }
  });

  it('APPLICATION provider bootstrap: getServerPersistenceProvider runs its FULL ensure chain inside the old schema and preserves the facts', async () => {
    const schema = await newSyntheticSchema('bootstrap');
    try {
      await dropFixtureTables();
      await buildOldMistakeTable();
      await seedMistakeRows();

      // The REAL application bootstrap (createServerPersistenceProvider:
      // every ensure — SDK, stage-meta, owner-materials, mistake-book,
      // assets — plus the document store construction), pointed at this
      // synthetic schema through the URL's search_path options. This is the
      // actual path production takes on process start.
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      const scopedUrl = `${contractUrl}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
      const provider = await getServerPersistenceProvider(scopedUrl);
      expect(provider).toBeTruthy();
      try {
        // The bootstrap's own migration added the new columns in-schema and
        // preserved every seeded row (queried through the provider's pool).
        const rows = await provider.pool.query(
          'SELECT owner_id, question_id, wrong_count, first_wrong_at, last_wrong_at, subject, grade_semester FROM mistake_record ORDER BY owner_id, question_id',
        );
        expect(rows.rows).toEqual([
          {
            owner_id: 'owner-old-a',
            question_id: 'q1',
            wrong_count: 4,
            first_wrong_at: 1_000.5,
            last_wrong_at: 9_000.25,
            subject: null,
            grade_semester: null,
          },
          {
            owner_id: 'owner-old-a',
            question_id: 'q9',
            wrong_count: 1,
            first_wrong_at: 3_000,
            last_wrong_at: 3_000,
            subject: null,
            grade_semester: null,
          },
          {
            owner_id: 'owner-old-b',
            question_id: 'q1',
            wrong_count: 2,
            first_wrong_at: 2_000,
            last_wrong_at: 8_000,
            subject: null,
            grade_semester: null,
          },
        ]);
        // The full chain provisioned the schema's document tables too.
        const documentTables = await provider.pool.query(
          `SELECT to_regclass('document_stages') AS stages, to_regclass('document_scenes') AS scenes`,
        );
        expect(documentTables.rows[0]!.stages).not.toBeNull();
        expect(documentTables.rows[0]!.scenes).not.toBeNull();
      } finally {
        await provider.pool.end().catch(() => undefined);
      }
    } finally {
      await dropFixtureTables().catch(() => undefined);
    }
  });
});
