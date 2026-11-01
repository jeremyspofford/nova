// A blank user's own folder with things setup could bring in (M10f): two notes, a calendar file and
// a browser's bookmarks, all placeholders. Used by the onboarding tests and the fresh-user test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const NOTE_WORD = 'Larkspur';

export function seedUserHome(home: string, o: { firefox?: boolean } = {}): void {
  mkdirSync(join(home, 'Notes', 'garden'), { recursive: true });
  writeFileSync(join(home, 'Notes', 'reading.md'), '# Reading list\n\nFinish the placeholder novel, then the one about lighthouses.\n');
  writeFileSync(join(home, 'Notes', 'garden', 'plants.md'), `# Garden plans\n\nPlant ${NOTE_WORD} by the north fence in spring. The soil there is clay.\n`);
  mkdirSync(join(home, 'Documents'), { recursive: true });
  writeFileSync(join(home, 'Documents', 'example.ics'), [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'SUMMARY:Dentist check-up', 'DTSTART:20261112T090000Z', 'LOCATION:Example Clinic', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Book club', 'DTSTART;VALUE=DATE:20261003', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n'));
  const chrome = join(home, '.config', 'google-chrome', 'Default');
  mkdirSync(chrome, { recursive: true });
  writeFileSync(join(chrome, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
        { type: 'folder', name: 'Recipes', children: [{ type: 'url', name: 'Example soup', url: 'https://recipes.example/soup' }, { type: 'url', name: 'Example bread', url: 'https://recipes.example/bread' }] },
        { type: 'url', name: 'Example news', url: 'https://news.example/' },
      ] },
      other: { type: 'folder', name: 'Other bookmarks', children: [] },
    },
  }));
  if (o.firefox) {
    const dir = join(home, '.mozilla', 'firefox', 'abcd.default');
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'places.sqlite'));
    db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, title TEXT);
      INSERT INTO moz_places VALUES (1, 'https://maps.example/'), (2, 'place:sort=8');
      INSERT INTO moz_bookmarks VALUES (10, 2, NULL, 0, 'Travel'), (11, 1, 1, 10, 'Example maps'), (12, 1, 2, 10, 'Recent tags');`);
    db.close();
  }
}
