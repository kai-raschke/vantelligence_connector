import chalk from 'chalk'
import mqtt from 'mqtt'
import fs from 'fs'
import 'dotenv/config';

const BASE_TOPIC = 'connector'
const DEVICE_TOPIC = 'device'
const CONFIG_TOPIC = 'config'
const DEVICE_PATH = './device/'
const DEVICE_CLASSES = {}
const DEVICE_INSTANCES = []

let SUBSCRIBED_TOPICS = {}
let PUBLISH_TOPICS = []

const deviceConfig = [
        {
            "class":"Ective_DSC",
            "id": 1,
            "connection": {
                "type": "serial",
                "port": "COM4"
            }
        }
    ];

fs.readdir(DEVICE_PATH, async (err, files) => {
    const mqttClient = connect();

    for (let file of files) {
        const deviceClass = String(file).slice(0, file.lastIndexOf('.'));
        for (let config in deviceConfig) {
            let device = deviceConfig[config];
            if (device.class === deviceClass) {
                const module = await import(DEVICE_PATH + file)

                DEVICE_CLASSES[String(file).slice(0, file.lastIndexOf('.'))] = module.default
            }
        }
    }

    await processConfig(mqttClient, {devices: deviceConfig});
})

function connect () {
    const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.split('=')))
    const host = args.host || process.env.MQTT_HOST || 'localhost'
    const options = {
        port: args.port || process.env.MQTT_PORT || 1883,
        username: args.username || process.env.MQTT_USERNAME,
        password: args.password || process.env.MQTT_PASSWORD
    }

    const client = mqtt.connect('mqtt://' + host, options)

    client.on('connect', () => {
        client.subscribe(BASE_TOPIC + '/' + CONFIG_TOPIC)
    })

    client.on('error', error => {
        log('⚠️', 'Error connecting mqtt at "' + chalk.cyan(host + ':' + options.port) + '": ' + chalk.red(error.code))
    })

    client.on('message', (topic, message) => {
        const parts = topic.split('/')

        if (parts[0] === BASE_TOPIC) {
            if (parts[1] === CONFIG_TOPIC) {
                log('✨', 'New config discovered. Processing...')

                processConfig(client, JSON.parse(message))
            } else if (SUBSCRIBED_TOPICS[topic] instanceof Object) {
                Object.keys(SUBSCRIBED_TOPICS[topic]).forEach(key => SUBSCRIBED_TOPICS[topic][key](parts[parts.length - 1], message.toString()))
            }
        }
    })

    return client;
}

async function processConfig (client, data) {
    Object.values(DEVICE_INSTANCES).forEach(device => {
        device.disconnect()
    })

    client.unsubscribe(Object.keys(SUBSCRIBED_TOPICS))

    SUBSCRIBED_TOPICS = {}
    PUBLISH_TOPICS = []

    for (let config of data.devices) {
        const deviceClass = DEVICE_CLASSES[config.class]

        if (deviceClass) {
            const device = new deviceClass(config)

            device.onEntityUpdate(entity => processEntity(client, device, entity, data.support))
            device.onMessage((icon, message) => log(icon, message, device))

            const result = await device.connect()
            const message = 'connects by ' + chalk.yellow(device.manufacturer + ' ' + device.model) + ': '

            if (typeof result === 'string') {
                log('⚡', message + chalk.black.bgRed(' FAIL ') + ' ' + result, device)
            } else {
                log('⚡', message + chalk.black.bgGreen(' SUCCESS '), device)

                if (config.subscribe instanceof Object) {
                    Object.entries(config.subscribe).forEach(([key, topic]) => subscribe(client, topic, device, key))
                }

                DEVICE_INSTANCES[device.id] = device
            }
        }
    }
}

function processEntity (client, device, entity, support) {
    publish(client, device, entity, support)

    if (entity.commands instanceof Array) {
        entity.commands.forEach(command => subscribe(client, getEntityTopic(device, entity) + '/' + command, device, entity.key))
    }
}

function publish (client, device, entity, support) {
    const topic = getEntityTopic(device, entity)
    if (!PUBLISH_TOPICS.includes(topic)) {
        log('📣', 'published entity "' + chalk.cyan(entity.name) + '" to topic "' + chalk.yellow(topic) + '"', device)

        client.publish(topic, JSON.stringify(entity), { retain: true })

        PUBLISH_TOPICS.push(topic)
    }

    if (entity.states instanceof Object) {
        Object.entries(entity.states).forEach(([key, state]) => {
            client.publish(getEntityTopic(device, entity) + '/' + key, String(state), { retain: true })
        })
    }
}

function subscribe (client, topic, device, key) {
    if (typeof SUBSCRIBED_TOPICS[topic] !== 'object') {
        SUBSCRIBED_TOPICS[topic] = {}
    }

    if (typeof SUBSCRIBED_TOPICS[topic][device.id] === 'function') {
        return false
    }

    SUBSCRIBED_TOPICS[topic][device.id] = (state, value) => device.handle(key, state, value)

    client.subscribe(topic)

    log('📡', 'subscribed to topic "' + chalk.yellow(topic) + '"', device)

    return true
}

function getEntityTopic (device, entity) {
    return [BASE_TOPIC, DEVICE_TOPIC, device.id, (entity.key ? entity.key : entity)].join('/')
}

function log (icon, message, device) {
    console.log((icon ? icon + '  ' : '') + (device ? chalk.black.bgCyan(' ' + device.name + ' ') + ' ' : '') + message)
}