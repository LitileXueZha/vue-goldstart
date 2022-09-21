const http = require('http');
const EventEmitter = require('events');
const fs = require('fs/promises');
const { createReadStream, watch } = require('fs');
const path = require('path');
const zlib = require('zlib');
const stream = require('stream');
process.env.DEBUG = '*';
process.env.DEBUG_COLORS = '1';
const debug = require('debug')('VGS');

const MIME_TYPES = {
    'js': 'application/javascript',
    'css': 'text/css',
    'html': 'text/html',
};
const SSE_CLIENT = `
<script>
const sse = new EventSource(location.origin + '/livereload');
sse.addEventListener('message', (ev) => {
    location.reload();
    console.log(ev.data);
});
sse.onerror = () => sse.close();
window.addEventListener('unload', () => sse.close());
</script>
`;

class LiveServer extends EventEmitter {
    constructor() {
        super();
        this.handle = this.handle.bind(this);
        this.watcher = null;
        this.fd = null;
        this._path = null;
    }

    /**
     * @param {http.IncomingMessage} req 
     * @param {http.ServerResponse} res 
     */
    handle(req, res) {
        debug('%s %s', req.method, req.url);

        if (req.url === '/livereload') {
            this.sse(req, res);
            return;
        }

        const ext = path.extname(req.url);
        const mime = MIME_TYPES[ext.substring(1)];
        if (mime) {
            res.setHeader('content-type', mime);
        }
        const filePath = this.realPath(req.url);
        const fStream = createReadStream(filePath);
        fStream.on('error', () => {
            res.statusCode = 404;
            res.end();
        });
        if (ext === '.map') {
            fStream.pipe(res);
        } else if (ext === '.html' || req.url === '/') {
            fStream.pipe(this.createSSEScripts()).pipe(res);
        } else {
            res.setHeader('content-encoding', 'gzip');
            fStream.pipe(zlib.createGzip()).pipe(res);
        }
    }

    /**
     * @param {http.IncomingMessage} req 
     * @param {http.ServerResponse} res 
     */
    sse(req, res) {
        res.setHeader('content-type', 'text/event-stream');
        res.write('event: sse\ndata: connected\n\n');

        const { pathname } = new URL(req.headers['referer']);
        const filePath = this.realPath(pathname);
        let buff = Buffer.alloc(0);
        let timer = null;

        this.reload = () => res.write('event: message\ndata: 1\n\n');
        if (!this.fd || filePath !== this._path) {
            fs.open(filePath, 'r').then(async (fd) => {
                if (this.fd) {
                    await this.fd.close();
                }
                this.fd = fd;
                const { size } = await fd.stat();
                const { buffer } = await fd.read({ buffer: Buffer.alloc(size) });
                buff = buffer;
            });
            this.watcher?.close();
            this.watcher = watch(filePath, (evt, filename) => {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    const { size } = await this.fd.stat();
                    const { buffer } = await this.fd.read({ buffer: Buffer.alloc(size), position: 0 });
    
                    if (buff.equals(buffer)) {
                        return;
                    }
                    buff = buffer;
                    this.reload();
                    debug('reload');
                }, 300);
            });
            this._path = filePath;
        }
    }

    realPath(pathname) {
        let filePath = pathname;
        if (filePath === '/') {
            filePath = '/index.html';
        }
        if (!filePath.startsWith('/node_modules')) {
            filePath = 'src' + filePath;
        }
        return path.join(__dirname, filePath);
    }

    createSSEScripts() {
        return new stream.Transform({
            transform(chunk, encoding, done) {
                if (!this._injected) {
                    const html = chunk.toString();
                    const index = html.indexOf('</head>');
                    if (index > -1) {
                        const htmlSSE = html.replace('</head>', `${SSE_CLIENT}</head>`);
                        done(null, htmlSSE);
                        this._injected = true;
                        return;
                    }
                }
                done(null, chunk);
            },
        });
    }
}


http.createServer(new LiveServer().handle).listen(9015, () => {
    debug('Listen on http://localhost:%o', 9015);
});
