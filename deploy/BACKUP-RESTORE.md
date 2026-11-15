# Backup da dawo da bayanai (Hausa)

Wannan kayan aiki yana yin SQLite backup ta **Online Backup API**. Ba ya kwafin babban fayil ɗin SQLite kai tsaye. Yana kuma kwafin duk fayilolin da ke media directory, ya ƙirƙiri timestamp da manifest, sannan ya tabbatar da SHA-256.

## Abin da ake buƙata

- Node.js 22.16 ko sama a injin da ke iya karanta persistent database da media.
- Wurin backup dabam da database da media, mai isasshen sarari da izinin rubutu.
- Kafin media copy, dakatar da upload, maye gurbin ko share video/poster, social upload, da playback conversion har sai umarnin backup ya ƙare. SQLite na iya ci gaba da rubutu; Online Backup API ne ke ɗaukar hoton database mai daidaito. Dakatar da rubutun media yana hana database snapshot ya nuna fayil ɗin da ba a kwafe ba.

## Yin backup

Yi wannan daga project checkout da ke kan host, kuma ka maye gurbin misalan `/mnt/...` da ainihin mount points na VPS:

```sh
node scripts/backup-restore.js backup \
  --database /mnt/hausa-film-finder/database/hausa-film-finder.sqlite \
  --media /mnt/hausa-film-finder/media \
  --destination /mnt/private-backups/hausa-film-finder \
  --media-quiesced
```

Umarnin zai buga sunan sabon backup folder. Ba ya goge ko tsaftace tsoffin backups. Idan backup bai kammala ba, zai bar folder mai `INCOMPLETE.txt`; kada a yi restore daga wannan folder. Kada a saka `.env`, kalmomin sirri, session secret, ko API keys cikin backup logs ko wurin da jama'a ke iya gani.

## Tabbatar da backup

Yi amfani da cikakken folder path da umarnin backup ya nuna:

```sh
node scripts/backup-restore.js verify --backup /mnt/private-backups/hausa-film-finder/BACKUP_FOLDER
```

Wannan yana duba hash na database da media, `PRAGMA integrity_check`, da `PRAGMA foreign_key_check`.

## Gwada restore zuwa sabon directory

Zaɓi sabon directory wanda babu shi tukuna. Kada ka yi amfani da directory ɗin da app ke amfani da shi:

```sh
node scripts/backup-restore.js restore \
  --backup /mnt/private-backups/hausa-film-finder/BACKUP_FOLDER \
  --destination /mnt/restore-tests/hausa-film-finder-restore-2026-11-10
```

Restore yana ƙin rubuta kan directory da ya riga ya wanzu. Bayan ya gama, a sake duba database idan ana so:

```sh
node scripts/backup-restore.js check \
  --database /mnt/restore-tests/hausa-film-finder-restore-2026-11-10/database.sqlite
```

Wannan restore directory na gwaji ba ya canza database na app. Bayan gwajin, mai VPS ne zai yanke shawarar yadda za a adana ko cire test restore; kayan aikin nan ba ya share komai.
