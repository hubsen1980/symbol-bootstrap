/*
 * Copyright 2020 NEM
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { existsSync, lstatSync, promises as fsPromises, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import * as Handlebars from 'handlebars';
import Logger from '../logger/Logger';
import LoggerFactory from '../logger/LoggerFactory';
import { LogType } from '../logger/LogType';
import * as util from 'util';
import * as _ from 'lodash';
import { textSync } from 'figlet';
import { Addresses, ConfigPreset, NodePreset } from '../model';
import { Preset } from './ConfigService';
import { flags } from '@oclif/command';
import { spawn } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const exec = util.promisify(require('child_process').exec);
const logger: Logger = LoggerFactory.getLogger(LogType.System);

export class BootstrapUtils {
    public static readonly defaultTargetFolder = 'target';
    public static readonly targetNodesFolder = 'nodes';
    public static readonly targetGatewaysFolder = 'gateways';
    public static readonly targetDatabasesFolder = 'databases';
    public static readonly targetNemesisFolder = 'nemesis';

    public static readonly CURRENT_USER = 'current';
    private static readonly pulledImages: string[] = [];

    private static presetInfoLogged = false;
    private static stopProcess = false;

    public static helpFlag = flags.help({ char: 'h', description: 'It shows the help of this command.' });

    public static targetFlag = flags.string({
        char: 't',
        description: 'The target folder where the symbol-bootstrap network is generated',
        default: BootstrapUtils.defaultTargetFolder,
    });

    private static onProcessListener = (() => {
        process.on('SIGINT', () => {
            BootstrapUtils.stopProcess = true;
        });
    })();

    public static deleteFolder(folder: string, excludeFiles: string[] = []): void {
        if (existsSync(folder)) {
            logger.info(`Deleting folder ${folder}`);
        }
        return BootstrapUtils.deleteFolderRecursive(folder, excludeFiles);
    }

    private static deleteFolderRecursive(folder: string, excludeFiles: string[] = []): void {
        if (existsSync(folder)) {
            readdirSync(folder).forEach((file: string) => {
                const currentPath = join(folder, file);
                if (excludeFiles.find((f) => f === currentPath)) {
                    logger.info(`File ${currentPath} excluded from deletion.`);
                    return;
                }
                if (lstatSync(currentPath).isDirectory()) {
                    // recurse
                    this.deleteFolderRecursive(
                        currentPath,
                        excludeFiles.map((file) => join(currentPath, file)),
                    );
                } else {
                    // delete file
                    unlinkSync(currentPath);
                }
            });
            if (!readdirSync(folder).length) rmdirSync(folder);
        }
    }

    public static deleteFile(file: string): void {
        if (existsSync(file) && lstatSync(file).isFile()) {
            unlinkSync(file);
        }
    }

    public static showBanner(): void {
        console.log(textSync('symbol-bootstrap', { horizontalLayout: 'full' }));
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public static validateIsDefined(value: any, message: string): void {
        if (value == undefined || value == null) {
            throw new Error(message);
        }
    }

    public static async pullImage(image: string): Promise<void> {
        this.validateIsDefined(image, 'Image must be provided');
        if (BootstrapUtils.pulledImages.indexOf(image) > -1) {
            return;
        }
        try {
            logger.info(`Pulling image ${image}`);
            const stdout = await this.spawn('docker', ['pull', image], true);
            const outputLines = stdout.toString().split('\n');
            logger.info(`Image pulled: ${outputLines[outputLines.length - 2]}`);
            BootstrapUtils.pulledImages.push(image);
        } catch (e) {
            logger.warn(`Image ${image} could not be pulled!`);
        }
    }

    public static async runImageUsingExec({
        catapultAppFolder,
        image,
        userId,
        workdir,
        cmds,
        binds,
    }: {
        catapultAppFolder: string;
        image: string;
        userId?: string | undefined;
        workdir?: string | undefined;
        cmds: string[];
        binds: string[];
    }): Promise<{ stdout: string; stderr: string }> {
        await BootstrapUtils.pullImage(image);
        const volumes = binds.map((b) => `-v ${b}`).join(' ');
        const userParam = userId ? `-u ${userId}` : '';
        const workdirParam = workdir ? `--workdir=${workdir}` : '';
        const environmentParam = `--env LD_LIBRARY_PATH=${catapultAppFolder}/lib:${catapultAppFolder}/deps`;
        const runCommand = `docker run --rm ${userParam} ${workdirParam} ${environmentParam} ${volumes} ${image} ${cmds
            .map((a) => `"${a}"`)
            .join(' ')}`;
        logger.info(`Running image using Exec: ${image} ${cmds.join(' ')}`);
        return await this.exec(runCommand);
    }

    public static loadPresetData(
        root: string,
        preset: Preset,
        assembly: string | undefined,
        customPresetFile: string | undefined,
        customPresetObject: any | undefined,
    ): ConfigPreset {
        const sharedPreset = this.loadYaml(join(root, 'presets', 'shared.yml'));
        const networkPreset = this.loadYaml(`${root}/presets/${preset}/network.yml`);
        const assemblyPreset = assembly ? this.loadYaml(`${root}/presets/${preset}/assembly-${assembly}.yml`) : {};
        const customPreset = customPresetFile ? this.loadYaml(customPresetFile) : {};
        //Deep merge
        const presetData = _.merge(sharedPreset, networkPreset, assemblyPreset, customPreset, customPresetObject, { preset });
        if (!BootstrapUtils.presetInfoLogged) {
            logger.info(`Generating config from preset ${preset}`);
            if (assembly) {
                logger.info(`Assembly preset ${assembly}`);
            }
            if (customPresetFile) {
                logger.info(`Custom preset file ${customPresetFile}`);
            }
        }
        BootstrapUtils.presetInfoLogged = true;
        if (presetData.assemblies && !assembly) {
            throw new Error(`Preset ${preset} requires assembly (-a, --assembly option). Possible values are: ${presetData.assemblies}`);
        }
        const presetDataWithDynamicDefaults = {
            ...presetData,
            nodes: this.dynamicDefaultNodeConfiguration(presetData.nodes),
        };
        return this.expandRepeat(presetDataWithDynamicDefaults);
    }

    public static dynamicDefaultNodeConfiguration(nodes?: NodePreset[]): NodePreset[] {
        return _.map(nodes || [], (node) => {
            const roles = this.resolveRoles(node);
            if (node.harvesting && node.api) {
                return {
                    syncsource: true,
                    filespooling: true,
                    partialtransaction: true,
                    openPort: true,
                    sinkType: 'Async',
                    enableSingleThreadPool: false,
                    brokerOpenPort: true,
                    addressextraction: true,
                    enableAutoSyncCleanup: false,
                    mongo: true,
                    zeromq: true,
                    ...node,
                    roles,
                };
            }
            if (node.harvesting) {
                return {
                    sinkType: 'Sync',
                    enableSingleThreadPool: true,
                    addressextraction: false,
                    mongo: false,
                    zeromq: false,
                    syncsource: true,
                    filespooling: false,
                    enableAutoSyncCleanup: true,
                    partialtransaction: false,
                    ...node,
                    roles,
                };
            }
            if (node.api) {
                return {
                    sinkType: 'Async',
                    syncsource: false,
                    filespooling: true,
                    partialtransaction: true,
                    enableSingleThreadPool: false,
                    addressextraction: true,
                    mongo: true,
                    zeromq: true,
                    enableAutoSyncCleanup: false,
                    ...node,
                    roles,
                };
            }
            throw new Error('A node must have at least one harvesting: true or api: true');
        });
    }
    private static resolveRoles(nodePreset: NodePreset): string {
        if (nodePreset.roles) {
            return nodePreset.roles;
        }
        const roles: string[] = [];
        if (nodePreset.harvesting) {
            roles.push('Peer');
        }
        if (nodePreset.api) {
            roles.push('Api');
        }
        if (nodePreset.voting) {
            roles.push('Voting');
        }
        return roles.join(',');
    }

    public static expandRepeat(presetData: ConfigPreset): ConfigPreset {
        return {
            ...presetData,
            databases: this.expandServicesRepeat(presetData, presetData.databases || []),
            nodes: this.expandServicesRepeat(presetData, presetData.nodes || []),
            gateways: this.expandServicesRepeat(presetData, presetData.gateways || []),
            nemesis: this.applyValueTemplate(presetData, presetData.nemesis),
        };
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public static applyValueTemplate(context: any, value: any): any {
        if (!value) {
            return value;
        }
        if (_.isArray(value)) {
            return this.expandServicesRepeat(context, value as []);
        }

        if (_.isObject(value)) {
            return _.mapValues(value, (v: any) => this.applyValueTemplate({ ...context, ...value }, v));
        }

        if (!_.isString(value)) {
            return value;
        }
        const compiledTemplate = Handlebars.compile(value);
        return compiledTemplate(context);
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public static expandServicesRepeat(context: any, services: any[]): any[] {
        return _.flatMap(services || [], (service) => {
            if (service.repeat === 0) {
                return [];
            }
            if (!service.repeat) {
                return [service];
            }

            return _.range(service.repeat).map((index) => {
                return _.omit(
                    _.mapValues(service, (v: any) => this.applyValueTemplate({ ...context, ...service, $index: index }, v)),
                    'repeat',
                );
            });
        });
    }

    public static loadExistingPresetData(target: string): ConfigPreset {
        try {
            return this.loadYaml(this.getGeneratedPresetLocation(target));
        } catch (e) {
            throw new Error(`${e.message}. Have you executed the 'config' command?`);
        }
    }

    public static getGeneratedPresetLocation(target: string): string {
        return join(target, 'preset.yml');
    }

    public static loadExistingAddresses(target: string): Addresses {
        try {
            return this.loadYaml(this.getGeneratedAddressLocation(target));
        } catch (e) {
            throw new Error(`${e.message}. Have you executed the 'config' command?`);
        }
    }

    public static getGeneratedAddressLocation(target: string): string {
        return join(target, 'addresses.yml');
    }

    public static sleep(ms: number): Promise<any> {
        // Create a promise that rejects in <ms> milliseconds
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve();
            }, ms);
        });
    }

    public static createVotingKey(votingPublicKey: string): string {
        return votingPublicKey.padEnd(96, '0');
    }

    public static poll(promiseFunction: () => Promise<boolean>, totalPollingTime: number, pollIntervalMs: number): Promise<boolean> {
        const startTime = new Date().getMilliseconds();
        return promiseFunction().then(async (result) => {
            if (result) {
                return true;
            } else {
                if (BootstrapUtils.stopProcess) {
                    return Promise.resolve(false);
                }
                const endTime = new Date().getMilliseconds();
                const newPollingTime: number = Math.max(totalPollingTime - pollIntervalMs - (endTime - startTime), 0);
                if (newPollingTime) {
                    logger.info(`Retrying in ${pollIntervalMs / 1000} seconds. Polling will stop in ${newPollingTime / 1000} seconds`);
                    await BootstrapUtils.sleep(pollIntervalMs);
                    return this.poll(promiseFunction, newPollingTime, pollIntervalMs);
                } else {
                    return false;
                }
            }
        });
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public static async generateConfiguration(templateContext: any, copyFrom: string, copyTo: string): Promise<void> {
        // Loop through all the files in the config folder
        await fsPromises.mkdir(copyTo, { recursive: true });
        const files = await fsPromises.readdir(copyFrom);
        await Promise.all(
            files.map(async (file: string) => {
                const fromPath = join(copyFrom, file);
                const toPath = join(copyTo, file);

                // Stat the file to see if we have a file or dir
                const stat = await fsPromises.stat(fromPath);

                if (stat.isFile()) {
                    if (toPath.indexOf('.mustache') > -1) {
                        const destinationFile = toPath.replace('.mustache', '');
                        const template = await BootstrapUtils.readTextFile(fromPath);
                        const compiledTemplate = Handlebars.compile(template);
                        const renderedTemplate = compiledTemplate({ ...templateContext });
                        await fsPromises.writeFile(destinationFile, renderedTemplate);
                    } else {
                        await fsPromises.copyFile(fromPath, toPath);
                    }
                } else if (stat.isDirectory()) {
                    await fsPromises.mkdir(toPath, { recursive: true });
                    await this.generateConfiguration(templateContext, fromPath, toPath);
                }
            }),
        );
    }

    public static async mkdir(path: string): Promise<void> {
        await fsPromises.mkdir(path, { recursive: true });
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public static async writeYaml(path: string, object: any): Promise<void> {
        const yamlString = this.toYaml(object);
        await BootstrapUtils.writeTextFile(path, yamlString);
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public static toYaml(object: any): string {
        return yaml.safeDump(object, { skipInvalid: true, indent: 4, lineWidth: 140, noRefs: true });
    }

    public static fromYaml(yamlString: string): any {
        return yaml.safeLoad(yamlString);
    }

    public static loadYaml(fileLocation: string): any {
        return this.fromYaml(this.loadFileAsText(fileLocation));
    }

    public static loadFileAsText(fileLocation: string): string {
        return readFileSync(fileLocation, 'utf8');
    }

    public static async writeTextFile(path: string, text: string): Promise<void> {
        await fsPromises.writeFile(path, text, 'utf8');
    }

    public static async readTextFile(path: string): Promise<string> {
        return await fsPromises.readFile(path, 'utf8');
    }

    private static dockerUserId: string;

    public static async resolveDockerUserFromParam(paramUser: string | undefined): Promise<string | undefined> {
        if (!paramUser || paramUser.trim() === '') {
            return undefined;
        }
        if (paramUser === BootstrapUtils.CURRENT_USER) {
            return BootstrapUtils.getDockerUserGroup();
        }
        return paramUser;
    }
    public static async createImageUsingExec(targetFolder: string, dockerFile: string, tag: string): Promise<string> {
        const runCommand = `docker build -f ${dockerFile} ${targetFolder} -t ${tag}`;
        logger.info(`Creating image image '${tag}' from ${dockerFile}`);
        return (await this.exec(runCommand)).stdout;
    }

    public static async exec(runCommand: string): Promise<{ stdout: string; stderr: string }> {
        logger.debug(`Exec command: ${runCommand}`);
        const { stdout, stderr } = await exec(runCommand);
        return { stdout, stderr };
    }

    public static async spawn(command: string, args: string[], useLogger: boolean): Promise<string> {
        const cmd = spawn(command, args);
        return new Promise<string>((resolve, reject) => {
            logger.info(`Spawn command: ${command} ${args.join(' ')}`);
            let logText = '';
            const log = (data: string, isError: boolean) => {
                logText = logText + `${data}\n`;
                if (useLogger) {
                    if (isError) logger.warn(data);
                    else logger.info(data);
                } else {
                    console.log(data);
                }
            };

            cmd.stdout.on('data', (data) => {
                log(`${data}`.trim(), false);
            });

            cmd.stderr.on('data', (data) => {
                log(`${data}`.trim(), true);
            });

            cmd.on('error', (error) => {
                log(`${error.message}`.trim(), true);
            });

            cmd.on('exit', (code, signal) => {
                if (code) {
                    log(`Process exited with code ${code} and signal ${signal}`, true);
                    reject(logText);
                } else {
                    resolve(logText);
                }
            });

            cmd.on('close', (code) => {
                if (code) {
                    log(`Process closed with code ${code}`, true);
                    reject(logText);
                } else {
                    resolve(logText);
                }
            });

            process.on('SIGINT', () => {
                resolve(logText);
            });
        });
    }

    public static async getDockerUserGroup(): Promise<string> {
        const isWin = process.platform === 'win32';
        if (isWin) {
            return '';
        }
        if (BootstrapUtils.dockerUserId !== undefined) {
            return BootstrapUtils.dockerUserId;
        }
        try {
            const { stdout } = await this.exec('echo $(id -u):$(id -g)');
            logger.info(`User for docker resolved: ${stdout}`);
            const user = stdout.trim();
            BootstrapUtils.dockerUserId = user;
            return user;
        } catch (e) {
            logger.info(`User for docker could not be resolved: ${e}`);
            return '';
        }
    }

    public static validateFolder(workingDirFullPath: string): void {
        if (!existsSync(workingDirFullPath)) {
            throw new Error(`${workingDirFullPath} folder does not exist`);
        }
        if (!lstatSync(workingDirFullPath).isDirectory()) {
            throw new Error(`${workingDirFullPath} is not a folder!`);
        }
    }

    public static getTargetFolder(target: string, absolute: boolean, ...paths: string[]): string {
        if (absolute) {
            return join(process.cwd(), target, ...paths);
        } else {
            return join(target, ...paths);
        }
    }

    public static getTargetNodesFolder(target: string, absolute: boolean, ...paths: string[]): string {
        return this.getTargetFolder(target, absolute, this.targetNodesFolder, ...paths);
    }

    public static getTargetGatewayFolder(target: string, absolute: boolean, ...paths: string[]): string {
        return this.getTargetFolder(target, absolute, this.targetGatewaysFolder, ...paths);
    }

    public static getTargetNemesisFolder(target: string, absolute: boolean, ...paths: string[]): string {
        return this.getTargetFolder(target, absolute, this.targetNemesisFolder, ...paths);
    }

    public static getTargetDatabasesFolder(target: string, absolute: boolean, ...paths: string[]): string {
        return this.getTargetFolder(target, absolute, this.targetDatabasesFolder, ...paths);
    }

    //HANDLEBARS READY FUNCTIONS:
    private static initialize = (() => {
        Handlebars.registerHelper('toAmount', BootstrapUtils.toAmount);
        Handlebars.registerHelper('toHex', BootstrapUtils.toHex);
        Handlebars.registerHelper('toSimpleHex', BootstrapUtils.toSimpleHex);
        Handlebars.registerHelper('toJson', BootstrapUtils.toJson);
        Handlebars.registerHelper('add', BootstrapUtils.add);
        Handlebars.registerHelper('minus', BootstrapUtils.minus);
    })();

    private static add(a: any, b: any): string | number {
        if (_.isNumber(a) && _.isNumber(b)) {
            return Number(a) + Number(b);
        }
        if (typeof a === 'string' && typeof b === 'string') {
            return a + b;
        }
        return '';
    }

    private static minus(a: any, b: any): number {
        if (!_.isNumber(a)) {
            throw new TypeError('expected the first argument to be a number');
        }
        if (!_.isNumber(b)) {
            throw new TypeError('expected the second argument to be a number');
        }
        return Number(a) - Number(b);
    }

    public static toAmount(renderedText: string | number): string {
        const numberAsString = (renderedText + '').split("'").join('');
        if (!numberAsString.match(/^\d+$/)) {
            throw new Error(`'${renderedText}' is not a valid integer`);
        }
        return (numberAsString.match(/\d{1,3}(?=(\d{3})*$)/g) || [numberAsString]).join("'");
    }

    public static toHex(renderedText: string): string {
        const numberAsString = BootstrapUtils.toSimpleHex(renderedText);
        return '0x' + (numberAsString.match(/\w{1,4}(?=(\w{4})*$)/g) || [numberAsString]).join("'");
    }
    public static toSimpleHex(renderedText: string): string {
        return renderedText.split("'").join('').replace(/^(0x)/, '');
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public static toJson(object: any): string {
        return JSON.stringify(object, null, 2);
    }
}
