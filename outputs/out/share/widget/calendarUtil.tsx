import { execAsync } from 'ags/process';

class CalendarService {
    constructor() {
        this.debug = true;
    }

    log(...args) {
        if (this.debug) {
            console.log('[CalendarService]', ...args);
        }
    }

    async getRawSourceData() {
        this.log('Fetching raw source data from EDS...');
        try {
            const result = await execAsync([
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.evolution.dataserver.Sources5',
                '--object-path', '/org/gnome/evolution/dataserver/SourceManager',
                '--method', 'org.freedesktop.DBus.ObjectManager.GetManagedObjects'
            ]);
            
            this.log('Raw result length:', result.length);
            return result;
        } catch (error) {
            this.log('ERROR fetching source data:', error);
            throw error;
        }
    }

    parseCalendarSources(rawData) {
        this.log('Parsing calendar sources...');
        const calendars = [];
        
        // Split by source paths to get individual sources
        const sourceBlocks = rawData.split('/org/gnome/evolution/dataserver/SourceManager/');
        
        for (const block of sourceBlocks) {
            if (!block.trim()) continue;
            
            // Extract source ID from the beginning
            const sourceIdMatch = block.match(/^(Source[^']*)/);
            if (!sourceIdMatch) continue;
            
            const sourceId = sourceIdMatch[1];
            
            // Extract UID
            const uidMatch = block.match(/'UID':\s*<'([^']+)'>/);
            const uid = uidMatch ? uidMatch[1] : null;
            
            // Extract DisplayName (without locale)
            const nameMatch = block.match(/DisplayName=([^\n\\]+)(?:\n|\\n)/);
            const name = nameMatch ? nameMatch[1].trim() : null;
            
            // Check for Calendar section
            const hasCalendarSection = block.includes('[Calendar]');
            
            // Extract backend if calendar section exists
            let backend = null;
            if (hasCalendarSection) {
                const backendMatch = block.match(/\[Calendar\][^}]*?BackendName=(\w+)/s);
                backend = backendMatch ? backendMatch[1] : null;
            }
            
            // Check if it's a calendar source (has Calendar section or is a calendar-related backend)
            if (hasCalendarSection || block.includes('BackendName=caldav')) {
                if (uid && name) {
                    calendars.push({
                        uid: uid,
                        name: name,
                        backend: backend || 'unknown',
                        sourceId: sourceId
                    });
                    this.log(`Found calendar: ${name} (${uid}) - Backend: ${backend}`);
                }
            }
        }
        
        return calendars;
    }

    async getCalendarSources() {
        try {
            const rawData = await this.getRawSourceData();
            const calendars = this.parseCalendarSources(rawData);
            
            this.log('=== FINAL CALENDAR LIST ===');
            this.log('Total calendars found:', calendars.length);
            calendars.forEach((cal, i) => {
                this.log(`${i + 1}. ${cal.name} (${cal.uid}) - Backend: ${cal.backend}`);
            });
            
            return calendars;
        } catch (error) {
            this.log('ERROR in getCalendarSources:', error);
            return [];
        }
    }

    async findICSFiles() {
        this.log('Searching for ICS files...');
        try {
            const result = await execAsync([
                'bash', '-c',
                'find ~/.cache/evolution/calendar ~/.local/share/evolution/calendar -name "*.ics" 2>/dev/null'
            ]);
            
            const files = result.trim().split('\n').filter(f => f);
            this.log('Found', files.length, 'ICS files:');
            files.forEach(f => this.log('  -', f));
            
            return files;
        } catch (error) {
            this.log('No ICS files found or error:', error);
            return [];
        }
    }

    async checkCalendarDatabases() {
        this.log('Looking for calendar databases...');
        try {
            const result = await execAsync([
                'bash', '-c',
                'ls -la ~/.cache/evolution/calendar/ 2>/dev/null'
            ]);
            
            this.log('Calendar cache directory:', result);
            
            // Also check for .db files
            const dbResult = await execAsync([
                'bash', '-c',
                'find ~/.cache/evolution/calendar -name "*.db" 2>/dev/null'
            ]);
            
            const files = dbResult.trim().split('\n').filter(f => f);
            this.log('Found', files.length, 'database files:');
            files.forEach(f => this.log('  -', f));
            
            return files;
        } catch (error) {
            this.log('No calendar cache found');
            return [];
        }
    }

    async getNextEventFromICS() {
        this.log('Trying to get next event from any ICS file...');
        
        try {
            const script = `
#!/bin/bash
set -o pipefail
shopt -s nullglob

next_time=""
next_summary=""
now=$(date +%Y%m%d%H%M%S)

dirs=("$HOME/.cache/evolution/calendar" "$HOME/.local/share/evolution/calendar")
for base in "\${dirs[@]}"; do
    [ -d "$base" ] || continue
    for dir in "$base"/*/; do
        [ -d "$dir" ] || continue
        for ics in "$dir"*.ics "$dir"calendar.ics; do
            [ -f "$ics" ] || continue

            inside=0
            cur_time=""
            cur_summary=""

            while IFS= read -r line; do
                if [[ $line == BEGIN:VEVENT ]]; then
                    inside=1
                    cur_time=""
                    cur_summary=""
                    continue
                fi

                if [[ $line == END:VEVENT ]]; then
                    if [[ -n "$cur_time" && -n "$cur_summary" ]]; then
                        if [[ "$cur_time" > "$now" ]]; then
                            if [[ -z "$next_time" || "$cur_time" < "$next_time" ]]; then
                                next_time="$cur_time"
                                next_summary="$cur_summary"
                            fi
                        fi
                    fi
                    inside=0
                    cur_time=""
                    cur_summary=""
                    continue
                fi

                if [[ $inside -eq 1 ]]; then
                    if [[ $line =~ ^DTSTART[^:]*:([0-9TZ]+) ]]; then
                        raw="\${BASH_REMATCH[1]}"
                        clean="\${raw//[^0-9]/}"
                        # Handle all-day dates (YYYYMMDD)
                        if [[ \${#clean} -eq 8 ]]; then
                            clean="\${clean}000000"
                        fi
                        cur_time="$clean"
                    elif [[ $line =~ ^SUMMARY:(.+) ]]; then
                        cur_summary="\${BASH_REMATCH[1]}"
                    fi
                fi
            done < "$ics"
        done
    done
done

if [[ -n "$next_summary" ]]; then
    echo "$next_summary|$next_time"
else
    echo ""
fi
`;
            
            const result = await execAsync(['bash', '-c', script]);
            this.log('Next event result:', result);
            return result;
        } catch (error) {
            this.log('Error getting next event:', error);
            return null;
        }
    }

    // Fallback: read Evolution cache.db and parse VEVENTs to find the next upcoming one
    async getNextEventFromCacheDB() {
        this.log('Falling back to cache.db search for next event...');
        try {
            const script = `
#!/bin/bash
set -o pipefail
shopt -s nullglob

now=$(date +%Y%m%d%H%M%S)
next_time=""
next_summary=""

for db in "$HOME/.cache/evolution/calendar"/*/cache.db; do
    [ -f "$db" ] || continue

    # Find a table that stores ICS components (prefer cal_components.component)
    table=""
    if sqlite3 "$db" ".tables" | grep -qw cal_components; then
        table="cal_components"
    else
        table=$(sqlite3 "$db" "SELECT name FROM sqlite_master WHERE type='table' AND (sql LIKE '%component TEXT%' OR sql LIKE '%component BLOB%' OR sql LIKE '%component%');" | head -n1)
    fi
    [ -n "$table" ] || continue

    candidate=$(sqlite3 "$db" "SELECT component FROM $table WHERE component LIKE '%BEGIN:VEVENT%';" 2>/dev/null | awk -v now="$now" '
        BEGIN { RS="END:VEVENT"; FS="\n" }
        {
            block=$0
            if (block ~ /BEGIN:VEVENT/) {
                # Extract DTSTART
                dt=""
                sum=""
                if (match(block, /DTSTART[^:]*:([0-9TZ;A-Za-z=:+-]+)/, m)) {
                    raw=m[1]
                    gsub(/[^0-9]/, "", raw)
                    if (length(raw)==8) raw=raw "000000"
                    dt=substr(raw,1,14)
                }
                # Extract SUMMARY
                if (match(block, /SUMMARY:([^\r\n]+)/, s)) {
                    sum=s[1]
                }
                if (dt != "" && sum != "" && dt > now) {
                    if (best=="" || dt < best_time) { best=sum "|" dt; best_time=dt }
                }
            }
        }
        END { if (best != "") print best }')

    if [[ -n "$candidate" ]]; then
        ct="\${candidate#*|}"
        if [[ -z "$next_time" || "$ct" < "$next_time" ]]; then
            next_time="$ct"
            next_summary="\${candidate%|*}"
        fi
    fi
done

if [[ -n "$next_time" ]]; then
    echo "$next_summary|$next_time"
fi
`;
            const result = await execAsync(['bash', '-c', script]);
            this.log('Next event (cache.db) result:', result);
            return result;
        } catch (error) {
            this.log('Error getting next event from cache.db:', error);
            return '';
        }
    }

    // Unified entry: try ICS first, then cache.db
    async getNextEvent() {
        const ics = await this.getNextEventFromICS();
        const trimmed = (ics || '').toString().trim();
        if (trimmed) return trimmed;

        this.log('No event via ICS, trying cache.db...');
        const db = await this.getNextEventFromCacheDB();
        return (db || '').toString().trim();
    }
}

export default new CalendarService();