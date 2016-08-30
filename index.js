const _ = require('lodash')
const Bacon = require('baconjs')
const crypto = require('crypto')
const fs = require('fs')
const mkdirp = require('mkdirp')
const path = require('path')
const request = require('request')
const semver = require('semver')
const url = require('url')

const argv = require('minimist')(process.argv.slice(2));
const NPMJS_URL = argv.rootUrl || 'https://registry.npmjs.org'

const rootPackage = argv.packageJson
if (!rootPackage) {
  throw new Error('Mandatory parameter --packageJson missing')
}

const targetFolder = argv.targetFolder
if (!targetFolder) {
  throw new Error('Mandatory parameter --targetFolder missing')
}

const serverUrl = argv.serverUrl
if (!serverUrl) {
  throw new Error('Mandatory parameter --serverUrl missing')
}

const responseCache = {}

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex')
}

function fetchUrl(url, bodyIsBinary) {
  if (responseCache[url]) {
    return Bacon.later(0, responseCache[url])
  }

  return Bacon.fromNodeCallback((callback) => {
    request(url, { timeout: 20000, encoding: bodyIsBinary ? null : undefined }, (error, response, body) => {
      if (!error && response.statusCode == 200) {
        if (!url.endsWith('.tgz')) {
          responseCache[url] = body
        }
        callback(null, body)
      } else {
        const statusCode = response ? response.statusCode : 'n/a'
        callback(`Failed to fetch ${url} because of error '${error}' and/or HTTP status ${statusCode}`)
      }
    })
  })
}

function fetchMetadata(name) {
  return fetchUrl(url.resolve(NPMJS_URL, name)).map(JSON.parse)
}

function fetchVersionMetadata(name, version) {
  return fetchUrl(url.resolve(NPMJS_URL, name + '/' + version)).map(JSON.parse)
}

function fetchBinary(dist) {
  return fetchUrl(dist.tarball, true)
}

function dependenciesToArray(dependencies) {
  return Object.keys(dependencies || {}).map(function(key) {
    return { name: key, versionRange: dependencies[key] }
  })
}

function packageFilename(name, version) {
    return name + '-' + version + '.tgz'
}

function packageMetadataFilePath(name) {
  mkdirp.sync(path.resolve(targetFolder, name))
  return path.resolve(targetFolder, name + '/index.json')
}

function packageBinaryFilePath(name, version) {
  return path.resolve(targetFolder, name + '/' + packageFilename(name, version))
}

function packageBinaryFileUrl(name, version) {
  return url.resolve(serverUrl, name + '/' + packageFilename(name, version))
}

const collectedPackages = {}

function collectPackage(package) {
  const versions = collectedPackages[package.name] || []
  if (versions.indexOf(package.version) != -1) {
    return false
  }
  versions.push(package.version)
  collectedPackages[package.name] = versions
  return true
}

function collectedPackagesAsArray() {
  return Object.keys(collectedPackages).map(function(name) {
    return { name: name, versions: collectedPackages[name] }
  })
}

function resolveVersionAndDependencies(package) {
  return fetchMetadata(package.name)
         .map(function(metadata) {
           const available = Object.keys(metadata.versions)
           const version = semver.maxSatisfying(available, package.versionRange)
           return {name: package.name, version: version, dependencies: dependenciesToArray(metadata.versions[version].dependencies)}
         })
         .flatMap(function(packageAndDependencies) {
           if (collectPackage(packageAndDependencies)) {
             return Bacon.fromArray(packageAndDependencies.dependencies)
                         .flatMapConcat(resolveVersionAndDependencies)
           }
           return Bacon.never()
         })
}

function binaryExists(distribution) {
  return fs.existsSync(packageBinaryFilePath(distribution.name, distribution.version))
}

function downloadPackage(nameAndVersions) {
  function cleanupMetadata(metadataContent, versions) {
    const content = _.cloneDeep(metadataContent)
    Object.keys(content.versions).forEach(function(version) {
      if (versions.indexOf(version) == -1) {
        delete content.versions[version]
        delete content.time[version]
      } else {
        content.versions[version].dist.tarball = packageBinaryFileUrl(nameAndVersions.name, version)
      }
    })
    return content
  }

  return fetchMetadata(nameAndVersions.name)
           .doAction(function(metadataContent) {
             const file = packageMetadataFilePath(nameAndVersions.name)
             const content = JSON.stringify(cleanupMetadata(metadataContent, nameAndVersions.versions))
             if (content != fs.readFileSync(file)) {
               fs.writeFileSync(file, content)
             }
           })
           .flatMap(function(metadataContent) {
             const distributions = nameAndVersions.versions.map(function(version) {
               return {name: nameAndVersions.name, version: version, dist: metadataContent.versions[version].dist }
             })
             return Bacon.fromArray(distributions)
           })
           .flatMap(function(distribution) {
             if (binaryExists(distribution)) {
               return Bacon.once('Already downloaded ' + distribution.name + '@' + distribution.version)
             }
             return fetchBinary(distribution.dist)
                      .doAction(function(data) {
                        if (sha1(data) != distribution.dist.shasum) {
                          throw new Error('SHA checksum of ' + distribution.name + '@' + distribution.version + ' does not match')
                        }
                        fs.writeFileSync(packageBinaryFilePath(distribution.name, distribution.version), data)
                      })
                      .map('Downloaded ' + distribution.name + '@' + distribution.version)
           })
}

const dependencies = dependenciesToArray(require(rootPackage).dependencies)
const downloaded = Bacon.fromArray(dependencies)
     .flatMap(resolveVersionAndDependencies)
     .mapEnd(collectedPackagesAsArray)
     .flatMap(Bacon.fromArray)
     .flatMapWithConcurrencyLimit(5, downloadPackage)

downloaded.log()

downloaded.onError(function(err) {
  throw new Error(err)
})
