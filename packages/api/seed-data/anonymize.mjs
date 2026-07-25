/**
 * One-off: replace the real student-athlete identities in school.json with
 * synthetic ones (names + student numbers), keeping the academic metrics and all
 * structure so the seed still exercises the full RAG range. Run once; kept for
 * provenance. References in checkIns/interventions are remapped consistently.
 */
import fs from 'node:fs';

const path = new URL('./school.json', import.meta.url);
const db = JSON.parse(fs.readFileSync(path, 'utf8'));

const FIRST = ['Sipho','Thabo','Liam','Aiden','Kagiso','Ethan','Lwazi','Daniel','Sizwe','Ryan','Tumelo','James','Bongani','Connor','Anele','Joshua','Katlego','Michael','Themba','Luke','Musa','Nathan','Kabelo','Jordan','Siyabonga','Cameron','Lungelo','Matthew','Oscar','Neo','Farai','Sean','Andile','Blake','Tshepo','Dylan','Mpho','Reece','Zola','Aidan'];
const LAST = ['Nkosi','Botha','Dlamini','Smith','Mahlangu','Naidoo','Khumalo','Van Wyk','Mbeki','Adams','Zulu','Fourie','Mokoena','Peters','Ngcobo','Jacobs','Sithole','Meyer','Radebe','Hendricks','Molefe','Steyn','Maseko','Daniels','Ndlovu','Coetzee','Mthembu','Isaacs','Buthelezi','Pretorius','Mahlaba','Roberts','Nxumalo','Willemse','Modise','Abrahams','Cele','Fortuin','Gumede','Olivier'];
const MENTORS = ['Dr Naledi Khumalo','Mr David Petersen','Ms Ayanda Roberts','Mr Johan Fourie'];

const byOldNumber = new Map();
(db.athletes ?? []).forEach((a, i) => {
  const first = FIRST[i % FIRST.length];
  const last = LAST[(i * 7) % LAST.length];
  const num = `${last.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X')}${first.slice(0, 3).toUpperCase()}${String(i + 1).padStart(3, '0')}`;
  const identity = { firstName: first, lastName: last, studentNumber: num, mentor: a.mentor ? MENTORS[i % MENTORS.length] : a.mentor };
  byOldNumber.set(a.studentNumber, { ...identity, name: `${first} ${last}` });
  a.firstName = first;
  a.lastName = last;
  a.studentNumber = num;
  if (a.mentor) a.mentor = MENTORS[i % MENTORS.length];
});

const remap = (rows) =>
  (rows ?? []).forEach((r) => {
    const id = byOldNumber.get(r.studentNumber);
    if (!id) return;
    r.studentNumber = id.studentNumber;
    if (r.athleteName) r.athleteName = id.name;
    if (r.mentor && MENTORS.length) r.mentor = id.mentor ?? r.mentor;
  });
remap(db.checkIns);
remap(db.interventions);

fs.writeFileSync(path, JSON.stringify(db, null, 2));
console.log(`anonymized ${db.athletes?.length ?? 0} athletes; remapped ${db.checkIns?.length ?? 0} check-ins, ${db.interventions?.length ?? 0} interventions`);
