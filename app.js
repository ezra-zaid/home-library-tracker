// ===== FIREBASE CONFIG =====
// Paste your Firebase project config here after creating a project at firebase.google.com
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyCgGtn-0ytcc9diZYWNJW6qPR0ygp8k8Rw',
  authDomain:        'home-library-tracker-4b073.firebaseapp.com',
  projectId:         'home-library-tracker-4b073',
  storageBucket:     'home-library-tracker-4b073.firebasestorage.app',
  messagingSenderId: '366627136135',
  appId:             '1:366627136135:web:b521054a43e9b32d8b0e22',
};

const SYNC_ENABLED = FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';
let db             = null;
let syncUnsub      = null;
let lastSaveMs     = 0;
let libraryId      = localStorage.getItem('lib-library-id') || '';

// ===== STATE =====
const state = {
  books: [],
  members: [],
  filters: { status: 'all', member: 'all', shelf: 'all', search: '', sort: 'date-desc' },
};

// ===== STORAGE =====
function save() {
  try {
    localStorage.setItem('lib-books',   JSON.stringify(state.books));
    localStorage.setItem('lib-members', JSON.stringify(state.members));
  } catch {}
  syncToCloud();
}

// ===== FIREBASE SYNC =====
function generateLibraryId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) id += '-';
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function initFirebase() {
  if (!SYNC_ENABLED) return;
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    if (!libraryId) {
      libraryId = generateLibraryId();
      localStorage.setItem('lib-library-id', libraryId);
    }
    // If Firestore is empty but we have local books, push them up
    if (state.books.length > 0) {
      db.collection('libraries').doc(libraryId).get().then(doc => {
        const cloudBooks = doc.exists ? (doc.data().books || []) : [];
        if (cloudBooks.length === 0) syncToCloud();
      }).catch(() => {});
    }
    subscribeToLibrary();
  } catch (e) {
    console.warn('Firebase init failed', e);
  }
}

function syncToCloud() {
  if (!db || !libraryId) return;
  lastSaveMs = Date.now();
  db.collection('libraries').doc(libraryId).set({
    books:     state.books,
    members:   state.members,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
}

function subscribeToLibrary() {
  if (!db || !libraryId) return;
  if (syncUnsub) syncUnsub();
  syncUnsub = db.collection('libraries').doc(libraryId).onSnapshot(doc => {
    if (!doc.exists) return;
    if (Date.now() - lastSaveMs < 2000) return; // skip echo of our own writes
    const data = doc.data();
    if (data.books)   state.books   = data.books;
    if (data.members) state.members = data.members;
    try {
      localStorage.setItem('lib-books',   JSON.stringify(state.books));
      localStorage.setItem('lib-members', JSON.stringify(state.members));
    } catch {}
    renderAll();
  });
}

async function joinLibrary(newId) {
  const id = newId.trim().toUpperCase();
  if (!id || id === libraryId) return;
  if (syncUnsub) syncUnsub();
  libraryId = id;
  localStorage.setItem('lib-library-id', libraryId);
  if (!db) return;
  const doc = await db.collection('libraries').doc(libraryId).get();
  if (doc.exists) {
    const data = doc.data();
    state.books   = data.books   || [];
    state.members = data.members || [];
    try {
      localStorage.setItem('lib-books',   JSON.stringify(state.books));
      localStorage.setItem('lib-members', JSON.stringify(state.members));
    } catch {}
    renderAll();
    toast('Joined library! Data updated.', 'success');
  } else {
    syncToCloud();
    toast('New library created with your current books.', 'success');
  }
  subscribeToLibrary();
}

function load() {
  try {
    const b = localStorage.getItem('lib-books');
    const m = localStorage.getItem('lib-members');
    if (b) state.books   = JSON.parse(b);
    if (m) state.members = JSON.parse(m);
  } catch {}
}

// ===== HELPERS =====
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysAgo(dateStr) {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function findDuplicate(isbn, title, excludeId) {
  if (isbn) {
    const match = state.books.find(b => b.id !== excludeId && b.isbn && b.isbn === isbn.replace(/[^0-9X]/gi, ''));
    if (match) return match;
  }
  if (title) {
    const t = title.trim().toLowerCase();
    const match = state.books.find(b => b.id !== excludeId && b.title.trim().toLowerCase() === t);
    if (match) return match;
  }
  return null;
}

function renderStars(rating) {
  return [1,2,3,4,5].map(n => {
    const pct = Math.round(Math.max(0, Math.min(1, rating - (n - 1))) * 100);
    return `<span class="disp-star"><span class="disp-star-fill" style="width:${pct}%"></span></span>`;
  }).join('');
}

const STATUS_LABELS = { want: 'Want to Read', reading: 'Currently Reading', finished: 'Finished' };
const STATUS_BADGE  = { want: 'status-badge-want', reading: 'status-badge-reading', finished: 'status-badge-finished' };

// ===== BOOK LOOKUP (Google Books → Open Library fallback) =====

async function fetchDescriptionFromOpenLibrary(isbn) {
  try {
    const res  = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=details`);
    const data = await res.json();
    const book = data[`ISBN:${isbn}`];
    if (!book) return '';
    const d = book.details?.description;
    return ((d?.value || d || '')).toString().slice(0, 600);
  } catch { return ''; }
}

async function fetchBookByISBN(isbn) {
  const clean = isbn.replace(/[^0-9X]/gi, '');
  if (clean.length < 10) return null;

  // Try Google Books first
  try {
    const res  = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${clean}&maxResults=1`);
    const data = await res.json();
    if (data.items?.length) {
      const vol   = data.items[0].volumeInfo;
      const cover = (vol.imageLinks?.thumbnail || vol.imageLinks?.smallThumbnail || '')
        .replace('http:', 'https:');
      let description = (vol.description || '').slice(0, 600);

      // If description is too short, search all editions by title and pick the longest
      if (description.length < 80 && vol.title) {
        try {
          const res2  = await fetch(`https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(vol.title)}&maxResults=10`);
          const data2 = await res2.json();
          for (const item of (data2.items || [])) {
            const d = (item.volumeInfo.description || '').slice(0, 600);
            if (d.length > description.length) description = d;
          }
        } catch {}
      }

      // If still too short, try Open Library's details endpoint (often has a real synopsis)
      if (description.length < 80) {
        const olDesc = await fetchDescriptionFromOpenLibrary(clean);
        if (olDesc.length > description.length) description = olDesc;
      }

      // Split hierarchical Google Books categories ("Fiction / Horror") before normalizing
      let genres = normalizeGenres((vol.categories || []).flatMap(c => c.split(' / ')));
      // Supplement with Open Library subjects if Google Books returned fewer than 2 genres
      if (genres.length < 2) {
        const olGenres = await fetchGenresFromOpenLibrary(clean);
        const merged   = [...genres];
        for (const g of olGenres) { if (!merged.includes(g)) merged.push(g); }
        genres = merged.slice(0, 6);
      }
      return {
        isbn: clean,
        title:       vol.title || '',
        author:      (vol.authors || []).join(', '),
        coverUrl:    cover,
        description,
        publisher:   vol.publisher || '',
        genres,
      };
    }
  } catch {}

  // Fallback: Open Library (when Google Books has no results at all)
  try {
    const res  = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${clean}&format=json&jscmd=data`);
    const data = await res.json();
    const key  = `ISBN:${clean}`;
    const book = data[key];
    if (!book) return null;
    const cover = book.cover?.large || book.cover?.medium || book.cover?.small || '';
    let description = (book.notes?.value || book.notes || '').toString().slice(0, 600);
    if (description.length < 80) {
      const olDesc = await fetchDescriptionFromOpenLibrary(clean);
      if (olDesc.length > description.length) description = olDesc;
    }
    return {
      isbn: clean,
      title:       book.title || '',
      author:      (book.authors || []).map(a => a.name).join(', '),
      coverUrl:    cover.replace('http:', 'https:'),
      description,
      publisher:   (book.publishers || []).map(p => p.name).join(', '),
      genres:      normalizeGenres((book.subjects || []).map(s => s.name || s)),  // OL subjects run through GENRE_MAP filter
    };
  } catch { return null; }
}

// ===== GENRE SYSTEM =====
// Ordered most-specific → least-specific so the first match wins
const GENRE_MAP = [
  // Fiction sub-genres (before broad "Fiction")
  { match: /magical realism/i,                          label: 'Magical Realism' },
  { match: /urban fantasy/i,                            label: 'Urban Fantasy' },
  { match: /epic fantasy|high fantasy/i,                label: 'Epic Fantasy' },
  { match: /dark fantasy/i,                             label: 'Dark Fantasy' },
  { match: /science fantasy/i,                          label: 'Science Fantasy' },
  { match: /historical fiction|historical novel/i,      label: 'Historical Fiction' },
  { match: /literary fiction/i,                         label: 'Literary Fiction' },
  { match: /contemporary fiction/i,                     label: 'Contemporary Fiction' },
  { match: /science fiction|sci-fi|\bsci fi\b/i,        label: 'Science Fiction' },
  { match: /space opera/i,                              label: 'Space Opera' },
  { match: /cyberpunk/i,                                label: 'Cyberpunk' },
  { match: /steampunk/i,                                label: 'Steampunk' },
  { match: /hard science fiction/i,                     label: 'Hard SF' },
  { match: /time travel/i,                              label: 'Time Travel' },
  { match: /alternate history|alternative history/i,    label: 'Alternate History' },
  { match: /post.?apocalyptic|apocalyptic fiction/i,    label: 'Post-Apocalyptic' },
  { match: /dystopi/i,                                  label: 'Dystopian' },
  { match: /fantasy/i,                                  label: 'Fantasy' },
  { match: /horror/i,                                   label: 'Horror' },
  { match: /gothic fiction|gothic horror/i,             label: 'Gothic' },
  { match: /psychological thriller/i,                   label: 'Psychological Thriller' },
  { match: /legal thriller/i,                           label: 'Legal Thriller' },
  { match: /medical thriller/i,                         label: 'Medical Thriller' },
  { match: /thriller|suspense/i,                        label: 'Thriller' },
  { match: /cozy mystery/i,                             label: 'Cozy Mystery' },
  { match: /mystery|detective|whodunit/i,               label: 'Mystery' },
  { match: /crime fiction|crime novel/i,                label: 'Crime Fiction' },
  { match: /spy fiction|espionage/i,                    label: 'Spy & Espionage' },
  { match: /paranormal romance/i,                       label: 'Paranormal Romance' },
  { match: /romantic suspense/i,                        label: 'Romantic Suspense' },
  { match: /romance/i,                                  label: 'Romance' },
  { match: /adventure/i,                                label: 'Adventure' },
  { match: /western/i,                                  label: 'Western' },
  { match: /paranormal/i,                               label: 'Paranormal' },
  { match: /vampire/i,                                  label: 'Vampires' },
  { match: /zombie/i,                                   label: 'Zombies' },
  { match: /short stor|short fiction/i,                 label: 'Short Stories' },
  { match: /graphic novel|manga|comic/i,                label: 'Graphic Novel' },
  // Age categories
  { match: /young adult|ya fiction|\bteen fiction/i,    label: 'Young Adult' },
  { match: /middle grade/i,                             label: 'Middle Grade' },
  { match: /children|juvenile fiction|picture book/i,   label: "Children's" },
  // Non-fiction (specific before broad)
  { match: /autobiography/i,                            label: 'Autobiography' },
  { match: /memoir/i,                                   label: 'Memoir' },
  { match: /biography/i,                                label: 'Biography' },
  { match: /true crime/i,                               label: 'True Crime' },
  { match: /self.?help|personal development/i,          label: 'Self-Help' },
  { match: /popular science/i,                          label: 'Popular Science' },
  { match: /natural history/i,                          label: 'Natural History' },
  { match: /philosophy/i,                               label: 'Philosophy' },
  { match: /psychology/i,                               label: 'Psychology' },
  { match: /political science|politics/i,               label: 'Politics' },
  { match: /economics/i,                                label: 'Economics' },
  { match: /business/i,                                 label: 'Business' },
  { match: /travel writing|travel/i,                    label: 'Travel' },
  { match: /cooking|recipes|food/i,                     label: 'Food & Cooking' },
  { match: /religion|spirituality/i,                    label: 'Religion & Spirituality' },
  { match: /history/i,                                  label: 'History' },
  { match: /science/i,                                  label: 'Science' },
  { match: /essay/i,                                    label: 'Essays' },
  { match: /poetry|poems/i,                             label: 'Poetry' },
  { match: /humor|humour/i,                             label: 'Humor' },
  { match: /art\b|art history/i,                        label: 'Art' },
  { match: /music/i,                                    label: 'Music' },
  { match: /sport/i,                                    label: 'Sports' },
  { match: /health|medicine|wellness/i,                 label: 'Health & Medicine' },
  { match: /environment|ecology|climate/i,              label: 'Environment' },
  { match: /technology|computing/i,                     label: 'Technology' },
  // Themes / identities (always additive, not mutually exclusive)
  { match: /lgbtq|gay fiction|lesbian fiction|queer fiction|transgender/i, label: 'LGBTQ+' },
  { match: /feminist|feminism/i,                        label: 'Feminist' },
  { match: /coming.of.age/i,                            label: 'Coming of Age' },
  { match: /mental health/i,                            label: 'Mental Health' },
  { match: /race|racism|racial identity/i,              label: 'Race & Identity' },
  { match: /war fiction|war novel|military fiction/i,   label: 'Military Fiction' },
  { match: /war|military/i,                             label: 'War & Military' },
  { match: /family saga|family drama/i,                 label: 'Family Saga' },
  { match: /immigration|diaspora/i,                     label: 'Immigration' },
  { match: /class/i,                                    label: 'Class & Society' },
  // Broad fallbacks — only shown if nothing more specific matched
  { match: /\bnon.?fiction\b/i,                         label: 'Non-Fiction' },
  { match: /\bfiction\b/i,                              label: 'Fiction' },
];

// Genre labels that make "Fiction" or "Non-Fiction" redundant
const FICTION_SUBGENRES    = new Set(['Science Fiction','Fantasy','Horror','Mystery','Thriller','Romance','Historical Fiction','Literary Fiction','Contemporary Fiction','Young Adult','Middle Grade',"Children's",'Graphic Novel','Adventure','Dystopian','Paranormal','Western','Magical Realism','Urban Fantasy','Epic Fantasy','Dark Fantasy','Space Opera','Cyberpunk','Steampunk','Time Travel','Alternate History','Post-Apocalyptic','Short Stories','Crime Fiction','Spy & Espionage','Gothic','Psychological Thriller','Paranormal Romance','Vampires','Zombies','Coming of Age','Family Saga','Military Fiction','War & Military']);
const NONFICTION_SUBGENRES = new Set(['Biography','Autobiography','Memoir','True Crime','Self-Help','History','Science','Popular Science','Philosophy','Psychology','Business','Economics','Politics','Religion & Spirituality','Travel','Food & Cooking','Poetry','Essays','Humor','Art','Music','Sports','Health & Medicine','Environment','Technology','Natural History']);

function normalizeGenres(rawParts) {
  if (!rawParts || !rawParts.length) return [];
  // Split hierarchical strings like "Fiction / Science Fiction / Hard SF"
  const parts = rawParts.flatMap(s => String(s).split(' / ')).map(s => s.trim()).filter(Boolean);
  const seen   = new Set();
  const result = [];
  for (const part of parts) {
    const entry = GENRE_MAP.find(g => g.match.test(part));
    if (!entry) continue; // discard unmapped strings (character names, locations, etc.)
    if (seen.has(entry.label)) continue;
    seen.add(entry.label);
    result.push(entry.label);
    if (result.length >= 8) break;
  }
  // Remove "Fiction" if a more specific fiction sub-genre is present
  const hasFictionSub    = result.some(g => FICTION_SUBGENRES.has(g));
  const hasNonfictionSub = result.some(g => NONFICTION_SUBGENRES.has(g));
  return result
    .filter(g => !(g === 'Fiction'     && hasFictionSub))
    .filter(g => !(g === 'Non-Fiction' && hasNonfictionSub))
    .slice(0, 6);
}

async function fetchGenresFromOpenLibrary(isbn) {
  try {
    const res  = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const data = await res.json();
    const book = data[`ISBN:${isbn}`];
    if (!book) return [];
    const subjects = (book.subjects || []).map(s => s.name || s).filter(Boolean);
    return normalizeGenres(subjects);
  } catch { return []; }
}

// ===== SCANNER =====
let scanner      = null;
let scannerAlive = false;

async function startScanner(containerId, onResult) {
  if (!window.Html5Qrcode) return;
  if (scannerAlive) await stopScanner();
  const el = document.getElementById(containerId);
  if (!el) return;

  try {
    scanner = new Html5Qrcode(containerId, {
      verbose: false,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.QR_CODE,
      ],
    });
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 280, height: 120 } },
      async code => {
        if (!scannerAlive) return;
        await stopScanner();
        onResult(code);
      },
      () => {}
    );
    scannerAlive = true;
  } catch (err) {
    scanner = null; scannerAlive = false;
    const errEl = document.getElementById('scanner-error');
    if (errEl) {
      errEl.textContent = /ermission/i.test(err?.message || '')
        ? 'Camera permission denied. Switch to the ISBN or Manual tab.'
        : 'Camera not available. Switch to the ISBN or Manual tab.';
      errEl.classList.remove('hidden');
    }
  }
}

async function stopScanner() {
  if (!scanner) { scannerAlive = false; return; }
  const s = scanner;
  scanner = null; scannerAlive = false;
  try { if (s.isScanning) await s.stop(); s.clear(); } catch {}
}

// ===== TOAST =====
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
}

// ===== MODAL =====
async function openModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

async function closeModal() {
  await stopScanner();
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-body').innerHTML = '';
  document.body.style.overflow = '';
}

// ===== STATS =====
function renderStats() {
  const total    = state.books.length;
  const want     = state.books.filter(b => b.status === 'want').length;
  const reading  = state.books.filter(b => b.status === 'reading').length;
  const finished = state.books.filter(b => b.status === 'finished').length;
  const lent     = state.books.filter(b => b.lentTo).length;

  document.getElementById('stats-bar').innerHTML = `
    <span class="stat-chip">📚 ${total} book${total !== 1 ? 's' : ''}</span>
    ${want     ? `<span class="stat-chip">${want} want</span>` : ''}
    ${reading  ? `<span class="stat-chip chip-reading">📖 ${reading} reading</span>` : ''}
    ${finished ? `<span class="stat-chip chip-done">✅ ${finished} done</span>` : ''}
    ${lent     ? `<span class="stat-chip chip-lent">📤 ${lent} lent out</span>` : ''}
  `;
}

// ===== FILTER SELECTS =====
function updateFilterSelects() {
  const members = [...new Set(state.books.map(b => b.reader).filter(Boolean))].sort();
  const shelves  = [...new Set(state.books.map(b => b.shelf).filter(Boolean))].sort();

  const mSel = document.getElementById('member-filter');
  const sSel = document.getElementById('shelf-filter');

  mSel.innerHTML = `<option value="all">All Readers</option>` +
    members.map(m => `<option value="${esc(m)}" ${m === state.filters.member ? 'selected' : ''}>${esc(m)}</option>`).join('');
  sSel.innerHTML = `<option value="all">All Shelves</option>` +
    shelves.map(s => `<option value="${esc(s)}" ${s === state.filters.shelf ? 'selected' : ''}>${esc(s)}</option>`).join('');
}

// ===== BOOK GRID =====
function renderGrid() {
  const { status, member, shelf, search, sort } = state.filters;
  const q = search.toLowerCase().trim();

  const filtered = state.books.filter(b => {
    if (status === 'lent')   return !!b.lentTo;
    if (status !== 'all' && b.status !== status) return false;
    if (member !== 'all' && b.reader !== member) return false;
    if (shelf  !== 'all' && b.shelf  !== shelf)  return false;
    if (q && !b.title.toLowerCase().includes(q) && !(b.author || '').toLowerCase().includes(q)) return false;
    return true;
  });

  const STATUS_ORDER = { reading: 0, want: 1, finished: 2 };
  filtered.sort((a, b) => {
    switch (sort) {
      case 'title-asc':   return a.title.localeCompare(b.title);
      case 'author-asc':  return (a.author || '').localeCompare(b.author || '');
      case 'rating-desc': return (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title);
      case 'date-asc':    return (a.dateAdded || '').localeCompare(b.dateAdded || '');
      case 'series':      return (a.series || 'zzz').localeCompare(b.series || 'zzz') || (a.seriesOrder || 0) - (b.seriesOrder || 0);
      default:            return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.dateAdded || '').localeCompare(a.dateAdded || '');
    }
  });

  const grid = document.getElementById('book-grid');

  if (!filtered.length) {
    grid.innerHTML = emptyStateHTML(status, !!q);
    return;
  }

  grid.innerHTML = '';

  // Series grouping view
  if (sort === 'series') {
    const seriesMap = new Map();
    filtered.forEach(b => {
      const key = b.series || '';
      if (!seriesMap.has(key)) seriesMap.set(key, []);
      seriesMap.get(key).push(b);
    });
    seriesMap.forEach((books, seriesName) => {
      const section = document.createElement('div');
      section.className = 'grid-section';
      section.innerHTML = `<h2 class="section-header">${seriesName ? `📚 ${esc(seriesName)}` : 'Other Books'} <span class="section-count">${books.length}</span></h2>`;
      const inner = document.createElement('div');
      inner.className = 'books-inner-grid';
      books.forEach(b => inner.appendChild(makeBookCard(b)));
      section.appendChild(inner);
      grid.appendChild(section);
    });
    return;
  }

  // Default grouped view (status=all, no filters, default sort)
  const grouped = status === 'all' && !q && member === 'all' && shelf === 'all' && sort === 'date-desc';

  if (grouped) {
    [
      { key: 'reading',  label: '📖 Currently Reading' },
      { key: 'want',     label: '🔖 Want to Read' },
      { key: 'finished', label: '✅ Finished' },
    ].forEach(({ key, label }) => {
      const books = filtered.filter(b => b.status === key);
      if (!books.length) return;
      const section = document.createElement('div');
      section.className = 'grid-section';
      section.innerHTML = `<h2 class="section-header">${label} <span class="section-count">${books.length}</span></h2>`;
      const inner = document.createElement('div');
      inner.className = 'books-inner-grid';
      books.forEach(b => inner.appendChild(makeBookCard(b)));
      section.appendChild(inner);
      grid.appendChild(section);
    });
  } else {
    const inner = document.createElement('div');
    inner.className = 'books-inner-grid';
    filtered.forEach(b => inner.appendChild(makeBookCard(b)));
    grid.appendChild(inner);
  }
}

function emptyStateHTML(status, isSearching) {
  if (isSearching) return `<div class="empty-state"><div class="empty-state-icon">🔍</div><h2>No results</h2><p>Try a different title or author name.</p></div>`;
  const msgs = {
    all:      { icon: '📚', h: 'Your library is empty',      p: 'Tap <strong>+ Add Book</strong> to scan a barcode or enter an ISBN.' },
    want:     { icon: '🔖', h: 'No books on your wish list', p: 'Add a book and set its status to "Want to Read".' },
    reading:  { icon: '📖', h: 'Not reading anything yet',   p: 'Mark a book as "Currently Reading" to see it here.' },
    finished: { icon: '✅', h: 'No finished books yet',      p: 'Mark a book as "Finished" when you\'re done.' },
    lent:     { icon: '📤', h: 'Nothing lent out',           p: 'Open a book and tap "Lend" to track who has it.' },
  };
  const m = msgs[status] || msgs.all;
  return `<div class="empty-state"><div class="empty-state-icon">${m.icon}</div><h2>${m.h}</h2><p>${m.p}</p></div>`;
}

function makeBookCard(book) {
  const el = document.createElement('div');
  el.className = 'book-card';

  const coverHTML = book.coverUrl
    ? `<img src="${esc(book.coverUrl)}" alt="${esc(book.title)}" class="book-cover" loading="lazy">`
    : `<div class="book-cover-placeholder"><span class="cover-letter">${esc((book.title[0] || '?').toUpperCase())}</span></div>`;

  const stars  = (book.status === 'finished' && book.rating)
    ? `<p class="book-stars">${renderStars(book.rating)}</p>` : '';
  const reader = (book.reader && book.status === 'reading')
    ? `<p class="book-reader">👤 ${esc(book.reader)}</p>` : '';
  const lent   = book.lentTo
    ? `<p class="book-lent">📤 ${esc(book.lentTo)}</p>` : '';
  const series = book.series
    ? `<p class="book-series">${esc(book.series)}${book.seriesOrder ? ` #${book.seriesOrder}` : ''}</p>` : '';
  const genres = (book.genres || []).slice(0, 2).map(g => `<span class="genre-tag">${esc(g)}</span>`).join('');
  const genresHTML = genres ? `<div class="book-genres">${genres}</div>` : '';

  el.innerHTML = `
    <div class="book-cover-wrap status-${esc(book.status)}${book.lentTo ? ' lent' : ''}">
      <div class="cover-status-bar"></div>
      ${book.lentTo ? `<div class="lent-overlay">📤</div>` : ''}
      ${coverHTML}
    </div>
    <div class="book-info">
      <p class="book-title">${esc(book.title)}</p>
      <p class="book-author">${esc(book.author || 'Unknown author')}</p>
      ${series}${lent}${reader}${stars}${genresHTML}
    </div>`;

  el.addEventListener('click', () => showDetailModal(book.id));
  return el;
}

function renderAll() {
  renderStats();
  updateFilterSelects();
  renderGrid();
}

// ===== ADD BOOK MODAL =====
let addTab     = 'scan';
let addPrefill = null;

function showAddModal() {
  addTab = 'scan';
  addPrefill = null;
  renderAddModal();
}

function renderAddModal() {
  const showForm = addTab === 'manual' || addPrefill !== null;

  openModal(`
    <h2 class="modal-title">Add Book</h2>
    <div class="modal-tabs">
      <button class="modal-tab ${addTab === 'scan'   ? 'active' : ''}" data-tab="scan">📷 Scan</button>
      <button class="modal-tab ${addTab === 'isbn'   ? 'active' : ''}" data-tab="isbn">🔢 ISBN</button>
      <button class="modal-tab ${addTab === 'manual' ? 'active' : ''}" data-tab="manual">✏️ Manual</button>
    </div>
    ${addTab === 'scan' && !addPrefill ? `
      <div class="scanner-wrap">
        <div class="scanner-box"><div id="scanner-target"></div></div>
        <p class="scanner-hint">Point the camera at the barcode on the book's back cover</p>
        <p id="scanner-error" class="scanner-error hidden"></p>
      </div>` : ''}
    ${addTab === 'isbn' && !addPrefill ? `
      <div class="isbn-wrap">
        <div class="isbn-row">
          <input class="form-input" id="isbn-input" type="text" inputmode="numeric"
                 placeholder="e.g. 9780743273565" maxlength="17" autocomplete="off">
          <button class="btn btn-primary" id="isbn-lookup-btn">Look Up</button>
        </div>
        <p class="isbn-msg hidden" id="isbn-msg"></p>
      </div>` : ''}
    ${showForm ? bookFormHTML(addPrefill || {}, false) : ''}
  `);

  // Tab switching
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.tab;
      if (next === addTab && !addPrefill) return;
      await stopScanner();
      addTab = next; addPrefill = null;
      renderAddModal();
    });
  });

  if (addTab === 'scan' && !addPrefill) {
    requestAnimationFrame(() => startScanner('scanner-target', onScanResult));
  }
  if (addTab === 'isbn' && !addPrefill) wireISBNLookup();
  if (showForm) wireBookForm(addPrefill || {}, false);
}

async function onScanResult(isbn) {
  toast('Barcode found! Looking up book…', 'info');
  const book = await fetchBookByISBN(isbn);
  addPrefill = book || { isbn };
  renderAddModal();
  toast(book ? `Found: ${book.title}` : 'Not found — fill in details below', book ? 'success' : 'warn');
}

function wireISBNLookup() {
  const input = document.getElementById('isbn-input');
  const btn   = document.getElementById('isbn-lookup-btn');
  const msg   = document.getElementById('isbn-msg');

  async function doLookup() {
    const val = input.value.trim();
    if (!val) { showMsg('Enter an ISBN first.', 'err'); return; }
    btn.disabled = true; btn.textContent = '…';
    showMsg('Searching…', 'load');
    const book = await fetchBookByISBN(val);
    btn.disabled = false; btn.textContent = 'Look Up';
    if (book) {
      addPrefill = book; renderAddModal();
      toast(`Found: ${book.title}`, 'success');
    } else {
      showMsg('Not found. Try another ISBN or switch to Manual.', 'err');
    }
  }

  function showMsg(text, cls) {
    msg.textContent = text;
    msg.className = `isbn-msg ${cls}`;
    msg.classList.remove('hidden');
  }

  btn.addEventListener('click', doLookup);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
  input.focus();
}

// ===== BOOK FORM =====
function bookFormHTML(data, isEdit) {
  const status  = data.status || 'want';
  const rating  = data.rating || 0;
  const shelves = [...new Set(state.books.map(b => b.shelf).filter(Boolean))].sort();

  const hasCustomReader = data.reader && !state.members.includes(data.reader);
  const memberOpts = state.members
    .map(m => `<option value="${esc(m)}" ${m === data.reader ? 'selected' : ''}>${esc(m)}</option>`)
    .join('');

  return `
    <div class="book-form" id="book-form">
      <div class="form-cover-row">
        <div class="form-cover-preview" id="cover-preview-wrap">
          ${data.coverUrl
            ? `<img src="${esc(data.coverUrl)}" alt="Cover">`
            : `<span class="form-cover-placeholder-icon">📖</span>`}
        </div>
        <div class="form-cover-fields">
          <div class="form-group">
            <label class="form-label">Title <span class="required">*</span></label>
            <input class="form-input" id="f-title" type="text" value="${esc(data.title || '')}" placeholder="Book title" autocomplete="off">
          </div>
          <div class="form-group">
            <label class="form-label">Author</label>
            <input class="form-input" id="f-author" type="text" value="${esc(data.author || '')}" placeholder="Author name" autocomplete="off">
          </div>
        </div>
      </div>

      ${!data.coverUrl ? `
        <div class="form-group">
          <label class="form-label">Cover Image URL <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>
          <input class="form-input" id="f-cover-url" type="url" placeholder="https://…">
        </div>` : ''}

      <input type="hidden" id="f-isbn"  value="${esc(data.isbn  || '')}">
      <input type="hidden" id="f-cover" value="${esc(data.coverUrl || '')}">

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Series</label>
          <input class="form-input" id="f-series" type="text"
                 value="${esc(data.series || '')}" placeholder="e.g. Harry Potter" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-label">Book #</label>
          <input class="form-input" id="f-series-order" type="number" min="1"
                 value="${data.seriesOrder || ''}" placeholder="1">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Status</label>
        <div class="status-pills">
          <button type="button" class="status-pill ${status === 'want'     ? 'active' : ''}" data-status="want">Want to Read</button>
          <button type="button" class="status-pill ${status === 'reading'  ? 'active' : ''}" data-status="reading">Reading</button>
          <button type="button" class="status-pill ${status === 'finished' ? 'active' : ''}" data-status="finished">Finished</button>
        </div>
      </div>

      <div class="form-group" id="rating-group" ${status !== 'finished' ? 'style="display:none"' : ''}>
        <label class="form-label">Your Rating</label>
        <div class="stars-input" id="stars-input" role="slider" aria-label="Rating" aria-valuemin="0" aria-valuemax="5">
          ${[1,2,3,4,5].map(n => {
            const pct = Math.round(Math.max(0, Math.min(1, rating - (n-1))) * 100);
            return `<div class="star-item" data-idx="${n}"><span class="star-fill" style="width:${pct}%"></span></div>`;
          }).join('')}
        </div>
        <div class="stars-value" id="stars-value">${rating > 0 ? `${rating} / 5` : 'No rating'}</div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Who's reading it</label>
          <select class="form-select" id="f-reader">
            <option value="">— Nobody —</option>
            ${memberOpts}
            <option value="__new__" ${hasCustomReader ? 'selected' : ''}>+ New person…</option>
          </select>
          <input class="form-input" id="f-reader-new" type="text"
                 placeholder="Enter name"
                 value="${hasCustomReader ? esc(data.reader) : ''}"
                 style="margin-top:6px;${hasCustomReader ? '' : 'display:none'}">
        </div>
        <div class="form-group">
          <label class="form-label">Shelf location</label>
          <input class="form-input" id="f-shelf" type="text" list="shelves-dl"
                 placeholder="e.g. Living Room Shelf 2"
                 value="${esc(data.shelf || '')}">
          <datalist id="shelves-dl">
            ${shelves.map(s => `<option value="${esc(s)}">`).join('')}
          </datalist>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea class="form-textarea" id="f-desc" placeholder="Book description…"
                  style="min-height:60px">${esc(data.description || '')}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Genre Tags <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:0.78rem">(comma-separated)</span></label>
        <input class="form-input" id="f-genres" type="text"
               value="${esc((data.genres || []).join(', '))}"
               placeholder="e.g. Fiction, Horror, LGBTQ+">
      </div>

      <div class="form-group">
        <label class="form-label">Notes / Review</label>
        <textarea class="form-textarea" id="f-notes" placeholder="Your thoughts, quotes, review…">${esc(data.notes || '')}</textarea>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" id="save-book-btn" type="button">
          ${isEdit ? 'Save Changes' : 'Add to Library'}
        </button>
        ${isEdit ? `<button class="btn btn-danger btn-sm" id="delete-book-btn" type="button">Delete</button>` : ''}
      </div>
    </div>`;
}

function wireBookForm(existingData, isEdit) {
  let rating = existingData.rating || 0;

  // Status pills → toggle rating section
  const ratingGroup = document.getElementById('rating-group');
  document.querySelectorAll('.status-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.status-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      ratingGroup.style.display = pill.dataset.status === 'finished' ? '' : 'none';
    });
  });

  // Star rating — quarter-star precision via mouse/touch position
  const starsContainer = document.getElementById('stars-input');
  const starsValueEl   = document.getElementById('stars-value');
  const starItems      = starsContainer ? [...starsContainer.querySelectorAll('.star-item')] : [];

  function starFillPct(idx, r) {
    return Math.round(Math.max(0, Math.min(1, r - (idx - 1))) * 100);
  }
  function refreshStarDisplay(r) {
    starItems.forEach((item, i) => {
      item.querySelector('.star-fill').style.width = starFillPct(i + 1, r) + '%';
    });
    if (starsValueEl) starsValueEl.textContent = r > 0 ? `${r} / 5` : 'No rating';
  }
  function ratingFromClientX(clientX) {
    for (const item of starItems) {
      const rect = item.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        const pct  = (clientX - rect.left) / rect.width;
        const frac = Math.max(0.25, Math.round(pct / 0.25) * 0.25);
        return (parseInt(item.dataset.idx) - 1) + frac;
      }
    }
    return 0;
  }
  if (starsContainer) {
    starsContainer.addEventListener('mousemove', e => refreshStarDisplay(ratingFromClientX(e.clientX)));
    starsContainer.addEventListener('mouseleave', () => refreshStarDisplay(rating));
    starsContainer.addEventListener('click', e => {
      const r = ratingFromClientX(e.clientX);
      rating = (rating === r) ? 0 : r;
      refreshStarDisplay(rating);
    });
    starsContainer.addEventListener('touchmove', e => {
      e.preventDefault();
      refreshStarDisplay(ratingFromClientX(e.touches[0].clientX));
    }, { passive: false });
    starsContainer.addEventListener('touchend', e => {
      const r = ratingFromClientX(e.changedTouches[0].clientX);
      if (r) rating = (rating === r) ? 0 : r;
      refreshStarDisplay(rating);
    });
  }

  // Reader: select ↔ free-text new person
  const readerSel = document.getElementById('f-reader');
  const readerNew = document.getElementById('f-reader-new');
  readerSel?.addEventListener('change', () => {
    const show = readerSel.value === '__new__';
    readerNew.style.display = show ? '' : 'none';
    if (show) readerNew.focus();
  });

  // Cover URL preview (manual mode, when no cover auto-filled)
  const coverUrlInput = document.getElementById('f-cover-url');
  const coverHidden   = document.getElementById('f-cover');
  const coverWrap     = document.getElementById('cover-preview-wrap');
  coverUrlInput?.addEventListener('input', () => {
    const url = coverUrlInput.value.trim();
    coverHidden.value = url;
    if (url) coverWrap.innerHTML = `<img src="${esc(url)}" alt="Cover" onerror="this.style.display='none'">`;
  });

  // Save
  let bypassDuplicateCheck = false;

  function doSave() {
    const title = document.getElementById('f-title')?.value.trim();
    if (!title) { toast('Title is required', 'warn'); return; }

    const isbn   = document.getElementById('f-isbn')?.value || existingData.isbn || '';
    const status = document.querySelector('.status-pill.active')?.dataset.status || 'want';

    // Duplicate check (skip on edit, skip if user already confirmed)
    if (!isEdit && !bypassDuplicateCheck) {
      const dupe = findDuplicate(isbn, title, existingData.id);
      if (dupe) {
        showDuplicateWarning(dupe, title);
        return;
      }
    }

    const selVal = readerSel?.value || '';
    let reader = '';
    if (selVal === '__new__')   reader = readerNew?.value.trim() || '';
    else if (selVal)            reader = selVal;

    if (reader && !state.members.includes(reader)) {
      state.members.push(reader);
      state.members.sort();
    }

    const book = {
      id:          existingData.id || genId(),
      isbn,
      title,
      author:      document.getElementById('f-author')?.value.trim() || '',
      coverUrl:    document.getElementById('f-cover')?.value || existingData.coverUrl || '',
      description:  document.getElementById('f-desc')?.value.trim()  || '',
      status,
      rating:       status === 'finished' ? rating : 0,
      reader,
      shelf:        document.getElementById('f-shelf')?.value.trim() || '',
      series:       document.getElementById('f-series')?.value.trim() || '',
      seriesOrder:  parseInt(document.getElementById('f-series-order')?.value) || 0,
      notes:        document.getElementById('f-notes')?.value.trim() || '',
      genres:       (document.getElementById('f-genres')?.value || '').split(',').map(g => g.trim()).filter(Boolean),
      dateAdded:   existingData.dateAdded || today(),
      dateFinished: status === 'finished'
        ? (existingData.dateFinished || today())
        : '',
    };

    const idx = state.books.findIndex(b => b.id === book.id);
    if (idx >= 0) state.books[idx] = book;
    else          state.books.push(book);

    save();
    closeModal();
    renderAll();
    toast(isEdit ? `"${book.title}" updated` : `"${book.title}" added to library!`, 'success');
  }

  function showDuplicateWarning(dupe, title) {
    document.getElementById('dupe-warning')?.remove();
    const actions = document.querySelector('.form-actions');
    if (!actions) return;
    const statusLabel = STATUS_LABELS[dupe.status] || dupe.status;
    actions.insertAdjacentHTML('beforebegin', `
      <div id="dupe-warning" class="dupe-warning">
        <strong>Already in your library</strong>
        <p>"${esc(dupe.title)}" is already added — currently <em>${esc(statusLabel)}</em>.</p>
        <div class="dupe-actions">
          <button class="btn btn-secondary btn-sm" id="dupe-view-btn">View existing</button>
          <button class="btn btn-primary btn-sm" id="dupe-add-btn">Add another copy</button>
        </div>
      </div>`);
    document.getElementById('dupe-view-btn').addEventListener('click', () => {
      closeModal();
      showDetailModal(dupe.id);
    });
    document.getElementById('dupe-add-btn').addEventListener('click', () => {
      bypassDuplicateCheck = true;
      document.getElementById('dupe-warning')?.remove();
      doSave();
    });
  }

  document.getElementById('save-book-btn')?.addEventListener('click', doSave);

  // Delete (edit only)
  document.getElementById('delete-book-btn')?.addEventListener('click', () => {
    if (!confirm(`Remove "${existingData.title}" from your library?`)) return;
    state.books = state.books.filter(b => b.id !== existingData.id);
    save();
    closeModal();
    renderAll();
    toast('Book removed', 'info');
  });
}

// ===== BOOK DETAIL MODAL =====
function showDetailModal(id) {
  const book = state.books.find(b => b.id === id);
  if (!book) return;

  const coverHTML = book.coverUrl
    ? `<img src="${esc(book.coverUrl)}" alt="${esc(book.title)}">`
    : `<div class="detail-cover-placeholder">📖</div>`;

  const days = book.lentTo ? daysAgo(book.lentDate) : 0;
  const lentHTML = book.lentTo ? `
    <div class="detail-lent-banner">
      <span>📤 Lent to <strong>${esc(book.lentTo)}</strong></span>
      <span class="lent-days-badge">${days === 0 ? 'Today' : `${days}d out`}</span>
    </div>` : '';

  const meta = [
    book.series       ? `<div class="detail-meta-row">📚 ${esc(book.series)}${book.seriesOrder ? ` — Book ${book.seriesOrder}` : ''}</div>` : '',
    book.reader       ? `<div class="detail-meta-row">👤 <strong>${esc(book.reader)}</strong></div>` : '',
    book.shelf        ? `<div class="detail-meta-row">📍 ${esc(book.shelf)}</div>` : '',
    book.dateFinished ? `<div class="detail-meta-row">🗓 Finished ${esc(book.dateFinished)}</div>` : '',
    book.isbn         ? `<div class="detail-meta-row" style="font-size:.72rem;color:var(--text-3)">ISBN ${esc(book.isbn)}</div>` : '',
  ].filter(Boolean).join('');

  const descHTML = book.description ? `
    <div style="margin-bottom:18px">
      <p class="detail-notes-label">Description</p>
      <div class="detail-notes detail-desc">${esc(book.description).replace(/\n/g, '<br>')}</div>
    </div>` : '';

  const notesHTML = book.notes ? `
    <div style="margin-bottom:18px">
      <p class="detail-notes-label">Notes</p>
      <div class="detail-notes">${esc(book.notes).replace(/\n/g, '<br>')}</div>
    </div>` : '';

  openModal(`
    ${lentHTML}
    <div class="detail-hero">
      <div class="detail-cover">${coverHTML}</div>
      <div class="detail-info">
        <p class="detail-title">${esc(book.title)}</p>
        <p class="detail-author">${esc(book.author || 'Unknown author')}</p>
        <span class="detail-status-badge ${STATUS_BADGE[book.status] || ''}">${STATUS_LABELS[book.status] || ''}</span>
        ${book.rating ? `<p class="detail-stars">${renderStars(book.rating)}</p>` : ''}
        ${(book.genres || []).length ? `<div class="detail-genres">${(book.genres).map(g => `<span class="genre-tag">${esc(g)}</span>`).join('')}</div>` : ''}
        <div class="detail-meta">${meta}</div>
      </div>
    </div>
    ${descHTML}${notesHTML}
    <div class="detail-actions">
      <button class="btn btn-primary" id="detail-edit-btn">Edit</button>
      ${book.lentTo
        ? `<button class="btn btn-lent btn-sm" id="detail-return-btn">Mark Returned</button>`
        : `<button class="btn btn-secondary btn-sm" id="detail-lend-btn">Lend</button>`}
      <button class="btn btn-ghost btn-sm" id="detail-close-btn">Close</button>
    </div>
  `);

  document.getElementById('detail-edit-btn').addEventListener('click', () => showEditModal(id));
  document.getElementById('detail-close-btn').addEventListener('click', closeModal);
  document.getElementById('detail-lend-btn')?.addEventListener('click', () => showLendModal(id));
  document.getElementById('detail-return-btn')?.addEventListener('click', () => returnBook(id));
}

// ===== LEND MODAL =====
function showLendModal(id) {
  const book = state.books.find(b => b.id === id);
  if (!book) return;

  const memberOpts = state.members
    .map(m => `<option value="${esc(m)}">${esc(m)}</option>`)
    .join('');

  openModal(`
    <h2 class="modal-title">Lend "${esc(book.title)}"</h2>
    <div class="book-form">
      <div class="form-group">
        <label class="form-label">Lend to</label>
        <select class="form-select" id="lend-member-sel">
          <option value="">— Pick a person —</option>
          ${memberOpts}
          <option value="__other__">Someone else…</option>
        </select>
        <input class="form-input" id="lend-name-input" type="text"
               placeholder="Type their name"
               style="margin-top:8px;display:none" autocomplete="off">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" id="lend-confirm-btn">Confirm Lend</button>
        <button class="btn btn-secondary btn-sm" id="lend-cancel-btn">Cancel</button>
      </div>
    </div>
  `);

  const sel   = document.getElementById('lend-member-sel');
  const input = document.getElementById('lend-name-input');
  sel.addEventListener('change', () => {
    input.style.display = sel.value === '__other__' ? '' : 'none';
    if (sel.value === '__other__') input.focus();
  });

  document.getElementById('lend-cancel-btn').addEventListener('click', () => showDetailModal(id));
  document.getElementById('lend-confirm-btn').addEventListener('click', () => {
    const name = sel.value === '__other__'
      ? input.value.trim()
      : sel.value;
    if (!name) { toast('Enter a name first', 'warn'); return; }

    const idx = state.books.findIndex(b => b.id === id);
    if (idx < 0) return;
    state.books[idx].lentTo   = name;
    state.books[idx].lentDate = today();
    save();
    renderAll();
    closeModal();
    toast(`"${book.title}" lent to ${name}`, 'success');
  });
}

// ===== RETURN BOOK =====
function returnBook(id) {
  const idx = state.books.findIndex(b => b.id === id);
  if (idx < 0) return;
  const name = state.books[idx].lentTo;
  state.books[idx].lentTo   = '';
  state.books[idx].lentDate = '';
  save();
  renderAll();
  closeModal();
  toast(`"${state.books[idx].title}" returned from ${name}`, 'success');
}

// ===== EDIT BOOK MODAL =====
function showEditModal(id) {
  const book = state.books.find(b => b.id === id);
  if (!book) return;
  openModal(`<h2 class="modal-title">Edit Book</h2>${bookFormHTML(book, true)}`);
  wireBookForm(book, true);
}

// ===== SETTINGS MODAL =====
function showSettingsModal() {
  renderSettingsModal();
}

function renderSettingsModal() {
  const memberListHTML = state.members.length
    ? state.members.map(m => `
        <div class="member-item">
          <span class="member-name">${esc(m)}</span>
          <button class="btn btn-ghost btn-sm remove-member-btn" data-name="${esc(m)}">✕</button>
        </div>`).join('')
    : `<p style="font-size:.83rem;color:var(--text-3)">No family members added yet.</p>`;

  const total = state.books.length;
  const kb    = (JSON.stringify(state.books).length / 1024).toFixed(1);

  const syncHTML = SYNC_ENABLED ? `
    <div class="settings-section">
      <h3>Sync &amp; Family Sharing <span class="sync-dot active" title="Sync active"></span></h3>
      <p style="font-size:.82rem;color:var(--text-2);margin-bottom:10px">
        Share your Library Code with family so everyone sees the same books in real time.
      </p>
      <div class="library-id-box">
        <span class="library-id-text" id="library-id-display">${esc(libraryId)}</span>
        <button class="btn btn-secondary btn-sm" id="copy-id-btn">Copy</button>
      </div>
      <details style="margin-top:12px">
        <summary style="font-size:.82rem;color:var(--text-2);cursor:pointer;user-select:none">
          Join a different library…
        </summary>
        <div class="join-row" style="margin-top:8px">
          <input class="form-input" id="join-input" type="text" placeholder="e.g. ABCD-1234"
                 style="text-transform:uppercase;letter-spacing:.08em" autocomplete="off" maxlength="9">
          <button class="btn btn-primary btn-sm" id="join-btn">Join</button>
        </div>
        <p style="font-size:.75rem;color:var(--text-3);margin-top:6px">
          Warning: joining replaces your current library with the one you join.
        </p>
      </details>
    </div>` : `
    <div class="settings-section">
      <h3>Sync &amp; Family Sharing <span class="sync-dot inactive" title="Sync not configured"></span></h3>
      <p style="font-size:.82rem;color:var(--text-2);line-height:1.5">
        Sync is not set up yet. To enable it, create a free Firebase project and add the config to <code>app.js</code>.
      </p>
    </div>`;

  openModal(`
    <h2 class="modal-title">Settings</h2>

    <div class="settings-section">
      <h3>Family Members</h3>
      <div class="member-list" id="member-list">${memberListHTML}</div>
      <div class="add-member-row">
        <input class="form-input" id="new-member-input" type="text" placeholder="Add a name…" autocomplete="off">
        <button class="btn btn-primary btn-sm" id="add-member-btn">Add</button>
      </div>
    </div>

    ${syncHTML}

    <div class="settings-section">
      <h3>Library Info</h3>
      <p style="font-size:.85rem;color:var(--text-2);margin-bottom:6px">
        ${total} book${total !== 1 ? 's' : ''} · ~${kb} KB stored locally in your browser
      </p>
    </div>

    <div class="settings-section">
      <h3>Backup &amp; Restore</h3>
      <div class="form-row" style="margin-bottom:14px">
        <button class="btn btn-secondary btn-sm" id="export-btn">⬇ Export JSON</button>
        <button class="btn btn-secondary btn-sm" id="import-btn">⬆ Import JSON</button>
      </div>
      <div class="danger-zone">
        <p>Permanently removes all books. This cannot be undone.</p>
        <button class="btn btn-danger btn-sm" id="clear-all-btn">Clear All Books…</button>
      </div>
    </div>
  `);

  // Remove member
  document.getElementById('member-list').addEventListener('click', e => {
    const btn = e.target.closest('.remove-member-btn');
    if (!btn) return;
    state.members = state.members.filter(m => m !== btn.dataset.name);
    save();
    renderSettingsModal();
    updateFilterSelects();
  });

  // Add member
  const newInput = document.getElementById('new-member-input');
  const addBtn   = document.getElementById('add-member-btn');
  function addMember() {
    const name = newInput.value.trim();
    if (!name) return;
    if (state.members.includes(name)) { toast(`${name} is already listed`, 'warn'); return; }
    state.members.push(name);
    state.members.sort();
    save();
    renderSettingsModal();
    updateFilterSelects();
    toast(`${name} added`, 'success');
  }
  addBtn.addEventListener('click', addMember);
  newInput.addEventListener('keydown', e => { if (e.key === 'Enter') addMember(); });

  // Export
  document.getElementById('export-btn').addEventListener('click', () => {
    const json = JSON.stringify({ books: state.books, members: state.members }, null, 2);
    const a = Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(new Blob([json], { type: 'application/json' })),
      download: `my-library-${today()}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Library exported', 'success');
  });

  // Import
  document.getElementById('import-btn').addEventListener('click', () => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const data = JSON.parse(e.target.result);
          if (!Array.isArray(data.books)) throw new Error('bad format');
          state.books = data.books;
          if (Array.isArray(data.members)) state.members = data.members;
          save();
          closeModal();
          renderAll();
          toast(`Imported ${data.books.length} book${data.books.length !== 1 ? 's' : ''}`, 'success');
        } catch { toast('Invalid file — import failed', 'error'); }
      };
      reader.readAsText(file);
    });
    input.click();
  });

  // Clear all — requires typing DELETE
  document.getElementById('clear-all-btn').addEventListener('click', () => {
    const btn = document.getElementById('clear-all-btn');
    btn.style.display = 'none';
    btn.insertAdjacentHTML('afterend', `
      <div id="delete-confirm-wrap" style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
        <p style="font-size:.82rem;color:#c0392b">Type <strong>DELETE</strong> in all caps to confirm:</p>
        <input class="form-input" id="delete-confirm-input" type="text"
               placeholder="DELETE" autocomplete="off" style="border-color:#e74c3c">
        <div style="display:flex;gap:8px">
          <button class="btn btn-danger btn-sm" id="confirm-delete-btn" disabled>Confirm</button>
          <button class="btn btn-secondary btn-sm" id="cancel-delete-btn">Cancel</button>
        </div>
      </div>`);

    const input      = document.getElementById('delete-confirm-input');
    const confirmBtn = document.getElementById('confirm-delete-btn');
    input.focus();
    input.addEventListener('input', () => {
      confirmBtn.disabled = input.value !== 'DELETE';
    });
    confirmBtn.addEventListener('click', () => {
      state.books = [];
      save();
      closeModal();
      renderAll();
      toast('Library cleared', 'info');
    });
    document.getElementById('cancel-delete-btn').addEventListener('click', () => {
      document.getElementById('delete-confirm-wrap').remove();
      btn.style.display = '';
    });
  });

  // Sync UI
  if (SYNC_ENABLED) {
    document.getElementById('copy-id-btn')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(libraryId).then(() => toast('Library Code copied!', 'success'))
        .catch(() => toast(libraryId, 'info'));
    });
    document.getElementById('join-btn')?.addEventListener('click', () => {
      const val = document.getElementById('join-input')?.value.trim();
      if (!val) return;
      joinLibrary(val);
      closeModal();
    });
    document.getElementById('join-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const val = e.target.value.trim();
        if (val) { joinLibrary(val); closeModal(); }
      }
    });
  }
}

// ===== UPDATE BANNER =====
function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <p>🆕 App updated</p>
    <button id="update-reload">Reload</button>`;
  document.body.insertBefore(banner, document.body.firstChild);
  document.getElementById('update-reload').addEventListener('click', () => window.location.reload());
}

// ===== PWA INSTALL BANNER =====
let deferredInstall = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  if (!document.getElementById('install-banner')) {
    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.className = 'install-banner';
    banner.innerHTML = `
      <p>📲 Add <strong>My Library</strong> to your home screen for the best experience</p>
      <button id="install-yes">Install</button>
      <button id="install-no" style="background:none;border:none;color:rgba(255,255,255,.55);font-size:1.2rem;cursor:pointer;padding:0 4px;line-height:1">✕</button>`;
    document.body.insertBefore(banner, document.body.firstChild);
    document.getElementById('install-yes').addEventListener('click', async () => {
      deferredInstall?.prompt();
      await deferredInstall?.userChoice;
      deferredInstall = null;
      banner.remove();
    });
    document.getElementById('install-no').addEventListener('click', () => banner.remove());
  }
});

// ===== EVENTS =====
function setupEvents() {
  document.getElementById('add-btn').addEventListener('click', showAddModal);
  document.getElementById('settings-btn').addEventListener('click', showSettingsModal);

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  document.getElementById('status-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.status-tab');
    if (!tab) return;
    document.querySelectorAll('.status-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.filters.status = tab.dataset.status;
    renderGrid();
  });

  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.search = e.target.value; renderGrid(); }, 180);
  });

  document.getElementById('member-filter').addEventListener('change', e => {
    state.filters.member = e.target.value; renderGrid();
  });
  document.getElementById('shelf-filter').addEventListener('change', e => {
    state.filters.shelf = e.target.value; renderGrid();
  });
  document.getElementById('sort-select').addEventListener('change', e => {
    state.filters.sort = e.target.value; renderGrid();
  });
}

// ===== INIT =====
function init() {
  load();
  setupEvents();
  renderAll();
  initFirebase();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'SW_UPDATED') showUpdateBanner();
    });
  }
}

init();
