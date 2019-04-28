require('app-module-path').addPath(__dirname);

const { time } = require('lib/time-utils.js');
const { asyncTest, fileContentEqual, setupDatabase, revisionService, setupDatabaseAndSynchronizer, db, synchronizer, fileApi, sleep, clearDatabase, switchClient, syncTargetId, objectsEqual, checkThrowAsync } = require('test-utils.js');
const Folder = require('lib/models/Folder.js');
const Setting = require('lib/models/Setting.js');
const Note = require('lib/models/Note.js');
const NoteTag = require('lib/models/NoteTag.js');
const ItemChange = require('lib/models/ItemChange.js');
const Tag = require('lib/models/Tag.js');
const Revision = require('lib/models/Revision.js');
const BaseModel = require('lib/BaseModel.js');
const RevisionService = require('lib/services/RevisionService.js');
const { shim } = require('lib/shim');

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

describe('services_Revision', function() {

	beforeEach(async (done) => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
		done();
	});

	it('should create diff and rebuild notes', asyncTest(async () => {
		const service = new RevisionService();

		const n1_v1 = await Note.save({ title: '', author: 'testing' });
		await service.collectRevisions();
		await Note.save({ id: n1_v1.id, title: 'hello', author: 'testing' });
		await service.collectRevisions();
		const n1_v2 = await Note.save({ id: n1_v1.id, title: 'hello welcome', author: '' });
		await service.collectRevisions();

		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n1_v1.id);
		expect(revisions.length).toBe(2);
		expect(revisions[1].parent_id).toBe(revisions[0].id);

		const rev1 = await service.revisionNote(revisions, 0);
		expect(rev1.title).toBe('hello');
		expect(rev1.author).toBe('testing');

		const rev2 = await service.revisionNote(revisions, 1);
		expect(rev2.title).toBe('hello welcome');
		expect(rev2.author).toBe('');

		await time.sleep(0.5);

		await service.deleteOldRevisions(400);
		const revisions2 = await Revision.allByType(BaseModel.TYPE_NOTE, n1_v1.id);
		expect(revisions2.length).toBe(0);
	}));

	it('should delete old revisions (1 note, 2 rev)', asyncTest(async () => {
		const service = new RevisionService();

		const n1_v1 = await Note.save({ title: 'hello' });
		await service.collectRevisions();
		await time.sleep(1);
		const n1_v2 = await Note.save({ id: n1_v1.id, title: 'hello welcome' });
		await service.collectRevisions();

		await service.deleteOldRevisions(1000);
		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n1_v1.id);
		expect(revisions.length).toBe(1);

		const rev1 = await service.revisionNote(revisions, 0);
		expect(rev1.title).toBe('hello welcome');
	}));

	it('should delete old revisions (1 note, 3 rev)', asyncTest(async () => {
		const service = new RevisionService();

		const n1_v1 = await Note.save({ title: 'one' });
		await service.collectRevisions();
		await time.sleep(1);
		const n1_v2 = await Note.save({ id: n1_v1.id, title: 'one two' });
		await service.collectRevisions();
		await time.sleep(1);
		const n1_v3 = await Note.save({ id: n1_v1.id, title: 'one two three' });
		await service.collectRevisions();

		{
			await service.deleteOldRevisions(2000);
			const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n1_v1.id);
			expect(revisions.length).toBe(2);

			const rev1 = await service.revisionNote(revisions, 0);
			expect(rev1.title).toBe('one two');

			const rev2 = await service.revisionNote(revisions, 1);
			expect(rev2.title).toBe('one two three');
		}

		{
			await service.deleteOldRevisions(1000);
			const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n1_v1.id);
			expect(revisions.length).toBe(1);

			const rev1 = await service.revisionNote(revisions, 0);
			expect(rev1.title).toBe('one two three');
		}
	}));

	it('should delete old revisions (2 notes, 2 rev)', asyncTest(async () => {
		const service = new RevisionService();

		const n1_v1 = await Note.save({ title: 'note 1' });
		const n2_v1 = await Note.save({ title: 'note 2' });
		await service.collectRevisions();
		await time.sleep(1);
		const n1_v2 = await Note.save({ id: n1_v1.id, title: 'note 1 (v2)' });
		const n2_v2 = await Note.save({ id: n2_v1.id, title: 'note 2 (v2)' });
		await service.collectRevisions();

		await service.deleteOldRevisions(1000);

		{
			const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n1_v1.id);
			expect(revisions.length).toBe(1);
			const rev1 = await service.revisionNote(revisions, 0);
			expect(rev1.title).toBe('note 1 (v2)');
		}

		{
			const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n2_v1.id);
			expect(revisions.length).toBe(1);
			const rev1 = await service.revisionNote(revisions, 0);
			expect(rev1.title).toBe('note 2 (v2)');
		}
	}));

	it('should handle conflicts', asyncTest(async () => {
		const service = new RevisionService();

		// A conflict happens in this case:
		// - Device 1 creates note1 (rev1)
		// - Device 2 syncs and get note1
		// - Device 1 modifies note1 (rev2)
		// - Device 2 modifies note1 (rev3)
		// When reconstructing the notes based on the revisions, we need to make sure it follow the right
		// "path". For example, to reconstruct the note at rev2 it would be:
		// rev1 => rev2
		// To reconstruct the note at rev3 it would be:
		// rev1 => rev3
		// And not, for example, rev1 => rev2 => rev3

		const n1_v1 = await Note.save({ title: 'hello' });
		const noteId = n1_v1.id;
		const rev1 = await service.createNoteRevision(n1_v1);
		const n1_v2 = await Note.save({ id: noteId, title: 'hello Paul' });
		const rev2 = await service.createNoteRevision(n1_v2, rev1.id);
		const n1_v3 = await Note.save({ id: noteId, title: 'hello John' });
		const rev3 = await service.createNoteRevision(n1_v3, rev1.id);

		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, noteId);
		expect(revisions.length).toBe(3);
		expect(revisions[1].parent_id).toBe(rev1.id);
		expect(revisions[2].parent_id).toBe(rev1.id);

		const revNote1 = await service.revisionNote(revisions, 0);
		const revNote2 = await service.revisionNote(revisions, 1);
		const revNote3 = await service.revisionNote(revisions, 2);
		expect(revNote1.title).toBe('hello');
		expect(revNote2.title).toBe('hello Paul');
		expect(revNote3.title).toBe('hello John');
	}));

	it('should create a revision for notes that existed before the revision service, the first time it is saved', asyncTest(async () => {
		const n1 = await Note.save({ title: 'hello' });
		const noteId = n1.id;

		await sleep(0.1);

		// Simulate the revision service being installed now. There N1 is like an old
		// note that had been created before the service existed.
		Setting.setValue('revisionService.installedTime', Date.now());

		// A revision is created the first time a note is overwritten with new content, and
		// if this note doesn't already have an existing revision.
		// This is mostly to handle old notes that existed before the revision service. If these
		// old notes are changed, there's a chance it's accidental or due to some bug, so we
		// want to preserve a revision just in case.

		{
			await Note.save({ id: noteId, title: 'hello 2' });
			const all = await Revision.allByType(BaseModel.TYPE_NOTE, noteId);
			expect(all.length).toBe(1);
		}

		// If the note is saved a third time, we don't automatically create a revision. One
		// will be created x minutes later when the service collects revisions.

		{
			await Note.save({ id: noteId, title: 'hello 3' });
			const all = await Revision.allByType(BaseModel.TYPE_NOTE, noteId);
			expect(all.length).toBe(1);
		}
	}));

	it('should create a revision for notes that get deleted (recyle bin)', asyncTest(async () => {
		const n1 = await Note.save({ title: 'hello' });
		const noteId = n1.id;

		await Note.delete(noteId);

		await revisionService().collectRevisions();

		const all = await Revision.allByType(BaseModel.TYPE_NOTE, noteId);
		expect(all.length).toBe(1);
		const rev1 = await revisionService().revisionNote(all, 0);
		expect(rev1.title).toBe('hello');
	}));

	it('should not create a revision for notes that get deleted if there is already a revision', asyncTest(async () => {
		const n1 = await Note.save({ title: 'hello' });
		await revisionService().collectRevisions();
		const noteId = n1.id;
		await Note.save({ id: noteId, title: 'hello Paul' });
		await revisionService().collectRevisions(); // REV 1

		expect((await Revision.allByType(BaseModel.TYPE_NOTE, n1.id)).length).toBe(1);

		await Note.delete(noteId);

		// At this point there is no need to create a new revision for the deleted note
		// because we already have the latest version as REV 1
		await revisionService().collectRevisions();

		expect((await Revision.allByType(BaseModel.TYPE_NOTE, n1.id)).length).toBe(1);
	}));

	it('should not create a revision for new note the first time they are saved', asyncTest(async () => {
		const n1 = await Note.save({ title: 'hello' });

		{
			const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n1.id);
			expect(revisions.length).toBe(0);
		}

		await revisionService().collectRevisions();

		{
			const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n1.id);
			expect(revisions.length).toBe(0);
		}
	}));

	it('should abort collecting revisions when one of them is encrypted', asyncTest(async () => {
		const n1 = await Note.save({ title: 'hello' }); // CHANGE 1
		await revisionService().collectRevisions();
		await Note.save({ id: n1.id, title: 'hello Ringo' }); // CHANGE 2
		await revisionService().collectRevisions();
		await Note.save({ id: n1.id, title: 'hello George' }); // CHANGE 3
		await revisionService().collectRevisions();

		const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, n1.id);
		expect(revisions.length).toBe(2);

		const encryptedRevId = revisions[0].id;

		// Simulate receiving an encrypted revision
		await Revision.save({ id: encryptedRevId, encryption_applied: 1 });
		await Note.save({ id: n1.id, title: 'hello Paul' }); // CHANGE 4

		await revisionService().collectRevisions();

		// Although change 4 is a note update, check that it has not been processed
		// by the collector, due to one of the revisions being encrypted.
		expect(await ItemChange.lastChangeId()).toBe(4);
		expect(Setting.value('revisionService.lastProcessedChangeId')).toBe(3);

		// Simulate the revision being decrypted by DecryptionService
		await Revision.save({ id: encryptedRevId, encryption_applied: 0 });

		await revisionService().collectRevisions();

		// Now that the revision has been decrypted, all the changes can be processed
		expect(await ItemChange.lastChangeId()).toBe(4);
		expect(Setting.value('revisionService.lastProcessedChangeId')).toBe(4);
	}));

});