const program = require('commander')
const {startServer} = require('./server')

program
  .storeOptionsAsProperties()
  .version(require(`${__dirname}/../../../package.json`).version)
  .option('--root <path>', 'Path to serve NPM packages from')
  .option('--httpPort [number]', 'Local HTTP port to bind the server to (defaults to 8000)')
  .option('--httpsPort [number]', 'Local HTTPS port to bind the server to (defaults to 8443)')
  .option('--sslCert [path]', 'Optional path to SSL certificate file (defaults to listening only to HTTP)')
  .option('--sslKey [path]', 'Optional path to SSL private key file (defaults to listening only to HTTP)')
  .parse(process.argv)

if (!program.root) {
  console.error(program.help())
  process.exit(1)
}

const sslEnabled = program.sslCert && program.sslKey
const httpsOptions = sslEnabled ? {
  port: program.httpsPort || 8443,
  sslCert: program.sslCert,
  sslKey: program.sslKey
} : undefined

const options = {
  port: program.httpPort || 8000,
  root: program.root,
  https: httpsOptions
}

startServer(options)
