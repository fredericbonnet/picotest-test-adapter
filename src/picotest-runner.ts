/**
 * @file PicoTest test discovery & execution
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import { PicotestTestInfo } from './interfaces/picotest-test-info';

const { split } = require('split-cmd');

/**
 * Load PicoTest test list
 *
 * @param command Test command/path
 * @param cwd Directory to run the test within
 * @param loadArgs Arguments passed to test command at load time
 */
export function loadPicotestTests(
  command: string,
  cwd: string,
  loadArgs: string
): Promise<PicotestTestInfo[]> {
  return new Promise<PicotestTestInfo[]>((resolve, reject) => {
    try {
      // Check that cwd directory exists
      // Note: statSync will throw an error if path doesn't exist
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`Directory '${cwd}' does not exist`);
      }

      // Split args string into array for spawn
      const args = split(loadArgs);

      // Execute the test command to get the test list in JSON format
      const testProcess = child_process.spawn(command, args, { cwd });
      if (!testProcess.pid) {
        // Something failed, e.g. the executable or cwd doesn't exist
        throw new Error(`Cannot spaw command '${command}'`);
      }

      // Capture result on stdout
      const out: string[] = [];
      testProcess.stdout.on('data', (data) => {
        out.push(data);
      });

      // The 'exit' event is always sent even if the child process crashes or is
      // killed so we can safely resolve/reject the promise from there
      testProcess.once('exit', () => {
        try {
          const data = JSON.parse(out.join(''));
          const tests: PicotestTestInfo[] = [data];
          resolve(tests);
        } catch {
          reject(
            new Error(
              `Error parsing test list - Make sure to use a compatible test runner'`
            )
          );
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}
