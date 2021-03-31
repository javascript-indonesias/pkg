import Multistream from 'multistream';
import assert from 'assert';
import { execSync } from 'child_process';
import fs from 'fs';
import intoStream from 'into-stream';
import path from 'path';
import streamMeter from 'stream-meter';
import {
  STORE_BLOB,
  STORE_CONTENT,
  isDotNODE,
  snapshotify,
} from '../prelude/common';
import { log, wasReported } from './log';
import { fabricateTwice } from './fabricator';

function discoverPlaceholder(binaryBuffer, searchString, padder) {
  const placeholder = Buffer.from(searchString);
  const position = binaryBuffer.indexOf(placeholder);
  if (position === -1) return { notFound: true };
  return { position, size: placeholder.length, padder };
}

function injectPlaceholder(fd, placeholder, value, cb) {
  const { notFound, position, size, padder } = placeholder;
  if (notFound) assert(false, 'Placeholder for not found');
  if (typeof value === 'number') value = value.toString();
  if (typeof value === 'string') value = Buffer.from(value);
  const padding = Buffer.from(padder.repeat(size - value.length));
  value = Buffer.concat([value, padding]);
  fs.write(fd, value, 0, value.length, position, cb);
}

function discoverPlaceholders(binaryBuffer) {
  return {
    BAKERY: discoverPlaceholder(
      binaryBuffer,
      `\0${'// BAKERY '.repeat(20)}`,
      '\0'
    ),
    PAYLOAD_POSITION: discoverPlaceholder(
      binaryBuffer,
      '// PAYLOAD_POSITION //',
      ' '
    ),
    PAYLOAD_SIZE: discoverPlaceholder(binaryBuffer, '// PAYLOAD_SIZE //', ' '),
    PRELUDE_POSITION: discoverPlaceholder(
      binaryBuffer,
      '// PRELUDE_POSITION //',
      ' '
    ),
    PRELUDE_SIZE: discoverPlaceholder(binaryBuffer, '// PRELUDE_SIZE //', ' '),
  };
}

function injectPlaceholders(fd, placeholders, values, cb) {
  injectPlaceholder(fd, placeholders.BAKERY, values.BAKERY, (error) => {
    if (error) return cb(error);
    injectPlaceholder(
      fd,
      placeholders.PAYLOAD_POSITION,
      values.PAYLOAD_POSITION,
      (error2) => {
        if (error2) return cb(error2);
        injectPlaceholder(
          fd,
          placeholders.PAYLOAD_SIZE,
          values.PAYLOAD_SIZE,
          (error3) => {
            if (error3) return cb(error3);
            injectPlaceholder(
              fd,
              placeholders.PRELUDE_POSITION,
              values.PRELUDE_POSITION,
              (error4) => {
                if (error4) return cb(error4);
                injectPlaceholder(
                  fd,
                  placeholders.PRELUDE_SIZE,
                  values.PRELUDE_SIZE,
                  cb
                );
              }
            );
          }
        );
      }
    );
  });
}

function makeBakeryValueFromBakes(bakes) {
  const parts = [];
  if (bakes.length) {
    for (let i = 0; i < bakes.length; i += 1) {
      parts.push(Buffer.from(bakes[i]));
      parts.push(Buffer.alloc(1));
    }
    parts.push(Buffer.alloc(1));
  }
  return Buffer.concat(parts);
}

function replaceDollarWise(s, sf, st) {
  return s.replace(sf, () => st);
}

function makePreludeBufferFromPrelude(prelude) {
  return Buffer.from(
    `(function(process, require, console, EXECPATH_FD, PAYLOAD_POSITION, PAYLOAD_SIZE) { ${prelude}\n})` // dont remove \n
  );
}

function findPackageJson(nodeFile) {
  let dir = nodeFile;
  while (dir !== '/') {
    dir = path.dirname(dir);
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      break;
    }
  }
  if (dir === '/') {
    throw new Error(`package.json not found for "${nodeFile}"`);
  }
  return dir;
}

const platform = {
  macos: 'darwin',
  win: 'win32',
  linux: 'linux',
};

function nativePrebuildInstall(target, nodeFile) {
  const prebuild = path.join(
    __dirname,
    '../node_modules/.bin/prebuild-install'
  );
  const dir = findPackageJson(nodeFile);
  // parse the target node version from the binaryPath
  const nodeVersion = path.basename(target.binaryPath).split('-')[1];
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(nodeVersion)) {
    throw new Error(`Couldn't find node version, instead got: ${nodeVersion}`);
  }
  // prebuild-install will overwrite the target .node file. Instead, we're
  // going to:
  //  * Take a backup
  //  * run prebuild
  //  * move the prebuild to a new name with a platform/version extension
  //  * put the backed up file back
  const nativeFile = `${nodeFile}.${target.platform}.${nodeVersion}`;
  if (fs.existsSync(nativeFile)) {
    return nativeFile;
  }
  if (!fs.existsSync(`${nodeFile}.bak`)) {
    fs.copyFileSync(nodeFile, `${nodeFile}.bak`);
  }
  execSync(
    `${prebuild} -t ${nodeVersion} --platform ${
      platform[target.platform]
    } --arch ${target.arch}`,
    { cwd: dir }
  );
  fs.copyFileSync(nodeFile, nativeFile);
  fs.copyFileSync(`${nodeFile}.bak`, nodeFile);
  return nativeFile;
}

export default function producer({ backpack, bakes, slash, target, symLinks }) {
  return new Promise((resolve, reject) => {
    if (!Buffer.alloc) {
      throw wasReported(
        'Your node.js does not have Buffer.alloc. Please upgrade!'
      );
    }

    const { prelude } = backpack;
    let { entrypoint, stripes } = backpack;
    entrypoint = snapshotify(entrypoint, slash);
    stripes = stripes.slice();

    const vfs = {};
    for (const stripe of stripes) {
      let { snap } = stripe;
      snap = snapshotify(snap, slash);
      if (!vfs[snap]) vfs[snap] = {};
    }

    const snapshotSymLinks = {};
    for (const [key, value] of Object.entries(symLinks)) {
      const k = snapshotify(key, slash);
      const v = snapshotify(value, slash);
      snapshotSymLinks[k] = v;
    }
    let meter;
    let count = 0;

    function pipeToNewMeter(s) {
      meter = streamMeter();
      return s.pipe(meter);
    }

    function next(s) {
      count += 1;
      return pipeToNewMeter(s);
    }

    const binaryBuffer = fs.readFileSync(target.binaryPath);
    const placeholders = discoverPlaceholders(binaryBuffer);

    let track = 0;
    let prevStripe;

    let payloadPosition;
    let payloadSize;
    let preludePosition;
    let preludeSize;

    new Multistream((cb) => {
      if (count === 0) {
        return cb(undefined, next(intoStream(binaryBuffer)));
      }

      if (count === 1) {
        payloadPosition = meter.bytes;
        return cb(undefined, next(intoStream(Buffer.alloc(0))));
      }

      if (count === 2) {
        if (prevStripe && !prevStripe.skip) {
          const { store } = prevStripe;
          let { snap } = prevStripe;
          snap = snapshotify(snap, slash);
          vfs[snap][store] = [track, meter.bytes];
          track += meter.bytes;
        }

        if (stripes.length) {
          // clone to prevent 'skip' propagate
          // to other targets, since same stripe
          // is used for several targets
          const stripe = { ...stripes.shift() };
          prevStripe = stripe;

          if (stripe.buffer) {
            if (stripe.store === STORE_BLOB) {
              const snap = snapshotify(stripe.snap, slash);
              return fabricateTwice(
                bakes,
                target.fabricator,
                snap,
                stripe.buffer,
                (error, buffer) => {
                  if (error) {
                    log.warn(error.message);
                    stripe.skip = true;
                    return cb(undefined, intoStream(Buffer.alloc(0)));
                  }

                  cb(undefined, pipeToNewMeter(intoStream(buffer)));
                }
              );
            }

            return cb(undefined, pipeToNewMeter(intoStream(stripe.buffer)));
          }

          if (stripe.file) {
            if (stripe.file === target.output) {
              return cb(
                wasReported(
                  'Trying to take executable into executable',
                  stripe.file
                )
              );
            }

            assert.strictEqual(stripe.store, STORE_CONTENT); // others must be buffers from walker
            if (isDotNODE(stripe.file)) {
              try {
                const platformFile = nativePrebuildInstall(target, stripe.file);
                if (fs.existsSync(platformFile)) {
                  return cb(
                    undefined,
                    pipeToNewMeter(fs.createReadStream(platformFile))
                  );
                }
              } catch (err) {
                log.debug(`prebuild-install failed[${stripe.file}]:`, err);
              }
            }
            return cb(
              undefined,
              pipeToNewMeter(fs.createReadStream(stripe.file))
            );
          }

          assert(false, 'producer: bad stripe');
        } else {
          payloadSize = track;
          preludePosition = payloadPosition + payloadSize;
          return cb(
            undefined,
            next(
              intoStream(
                makePreludeBufferFromPrelude(
                  replaceDollarWise(
                    replaceDollarWise(
                      replaceDollarWise(
                        prelude,
                        '%VIRTUAL_FILESYSTEM%',
                        JSON.stringify(vfs)
                      ),
                      '%DEFAULT_ENTRYPOINT%',
                      JSON.stringify(entrypoint)
                    ),
                    '%SYMLINKS%',
                    JSON.stringify(snapshotSymLinks)
                  )
                )
              )
            )
          );
        }
      } else {
        return cb();
      }
    })
      .on('error', (error) => {
        reject(error);
      })
      .pipe(fs.createWriteStream(target.output))
      .on('error', (error) => {
        reject(error);
      })
      .on('close', () => {
        preludeSize = meter.bytes;
        fs.open(target.output, 'r+', (error, fd) => {
          if (error) return reject(error);
          injectPlaceholders(
            fd,
            placeholders,
            {
              BAKERY: makeBakeryValueFromBakes(bakes),
              PAYLOAD_POSITION: payloadPosition,
              PAYLOAD_SIZE: payloadSize,
              PRELUDE_POSITION: preludePosition,
              PRELUDE_SIZE: preludeSize,
            },
            (error2) => {
              if (error2) return reject(error2);
              fs.close(fd, (error3) => {
                if (error3) return reject(error3);
                resolve();
              });
            }
          );
        });
      });
  });
}
