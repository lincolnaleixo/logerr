// @ts-check
/* eslint-disable require-jsdoc */
/* eslint-disable node/no-unpublished-require */
const puppeteer = require('puppeteer-extra')
const pluginStealth = require('puppeteer-extra-plugin-stealth')
const pluginUA = require('puppeteer-extra-plugin-anonymize-ua')
const jsonfile = require('jsonfile')
const fs = require('fs')
const download = require('download')
const UserAgent = require('user-agents')
const { Random } = require('random-js')
const moment = require('moment-timezone')
const Cawer = require('cawer')
const axios = require('axios')
const cheerio = require('cheerio')
const Logering = require('logering')
const defaults = require('../resources/defaults.json')

class Spidering {

	constructor() {
		if (process.env.NODE_ENV === undefined) process.env.NODE_ENV = defaults.environment
		this.isDevelopmentEnv = process.env === 'DEVELOPMENT'

		this.createDefaultFolders()

		puppeteer.use(pluginStealth())
		puppeteer.use(pluginUA())

		const logger = new Logering('spidering')

		this.browser = ''
		this.page = ''
		this.logger = logger.get()
		this.cawer = new Cawer()
	}

	// Cookies
	// ----------------------------------------------------------------------

	async saveCookies(cookiesPath) {
		const cookiesFilePath = cookiesPath || this.cookiesPath
		const cookiesObject = await this.page.cookies()
		jsonfile.writeFileSync(cookiesFilePath, cookiesObject, { spaces: 2 })
		this.logger.info(`Cookies saved: ${cookiesPath}`)
	}

	async setCookies(cookiesPath) {
		const cookiesFilePath = cookiesPath || this.cookiesPath

		this.logger.info('Reading and setting cookies')

		if (fs.existsSync(cookiesFilePath)) {
			const content = fs.readFileSync(cookiesFilePath)
			const cookiesArr = JSON.parse(content)

			if (cookiesArr.length !== 0) {
				for (const cookie of cookiesArr) await this.page.setCookie(cookie)

				this.logger.info('Session has been loaded in the browser')
			}
		}

		this.logger.info('Done reading and setting cookies')
	}

	// ----------------------------------------------------------------------

	createDefaultFolders() {
		for (const folder of defaults.necessaryFolders) {
			if (!fs.existsSync(folder)) fs.mkdirSync(folder)
		}
	}

	async createBrowser(proxy) {
		this.logger.debug('Creating browser')

		if (proxy) {
			defaults.chromeArgs.push(`--proxy-server=${proxy}`)
			this.logger.info(`Using proxy ${proxy}`)
		}

		this.browser = await puppeteer.launch({
			headless: !this.isDevelopmentEnv,
			devtools: this.isDevelopmentEnv,
			dumpio: this.isDevelopmentEnv,
			ignoreHTTPSErrors: !this.isDevelopmentEnv,
			slowMo: 250,
			timeout: this.isDevelopmentEnv ? 10000 : 60000,
			defaultViewport: null,
			args: defaults.chromeArgs,
		})
	}

	async createPage(pageType) {
		this.logger.debug('Creating page')
		this.page = await this.browser.newPage()
		await this.setPageParameters(pageType)
	}

	async setCleanParameters() {
		await this.page.setRequestInterception(true)

		this.page.on('request', (request) => {
			if (request.resourceType() === 'image' || request.resourceType() === 'font') {
				request.abort()
			} else {
				request.continue()
			}
		})
	}

	async setVeryCleanParameters() {
		await this.page.setRequestInterception(true)

		const blockedResourceTypes = [
			'image',
			'font',
			'script',
			'stylesheet',
		]

		this.page.on('request', (request) => {
			if (blockedResourceTypes.indexOf(request.resourceType()) > -1) {
				request.abort()
			} else {
				request.continue()
			}
		})
	}

	async setPageParameters(pageType) {
		this.logger.debug(`Using page type: ${pageType}`)
		this.page.on('dialog', async (dialog) => {
			await dialog.accept()
		})
		if (pageType === 'clean') {
			await this.setCleanParameters()
		} else if (pageType === 'veryClean') {
			await this.setVeryCleanParameters()
		}

		await this.page._client.send('Page.setDownloadBehavior', {
			behavior: 'allow',
			downloadPath: defaults.downloadPath,
		})

		await this.setRandomUserAgent()
	}

	async handleNavigateToErrors(url, err) {
		const errorHandler = defaults.errorsHandlers
			.find((item) => err.message.indexOf(item.errorMessage) > -1)

		if (errorHandler === undefined) {
			this.logger.error(`Error on navigateTo url ${url}: ${err}`)
		} else {
			this.logger.error(errorHandler.errorMessage)
			this.logger.warn(`Sleep seconds: ${errorHandler.sleepingSeconds} | url: ${url}`)
			await this.cawer.sleep(errorHandler.sleepingSeconds)
		}

		await this.takeScreenshot(true)

		return true
	}

	async navigateTo(url, postBack) {
		try {
			this.url = url
			this.logger.info(`Navigating to url: ${url}`)

			const response = await this.page.goto(url, { waitUntil: [
				'networkidle0',
				'load',
				'domcontentloaded',
			] })
			const headers = response.headers()
			if (headers.status !== '200') throw new Error(`Error on getting the page contents. Response status: ${headers.status}`)

			const bytesReceived = await this.getTotalBytesReceived()
			this.logger.debug(`Total bytes received: ${bytesReceived}`)

			return true
		} catch (err) {
			if (this.handleNavigateToErrors(url, err)) this.navigateTo(url, postBack)

			return false
		}
	}

	async setRandomUserAgent() {
		// TODO only chrome desktop now supported
		const userAgent = new UserAgent([
			/Chrome/, {
				connection: { type: 'wifi' },
				deviceCategory: 'desktop',
			},
		])

		await this.page.setUserAgent(userAgent.data.userAgent)
	}

	async click(elementToClick, elementToWait, timeToWait) {
		try {
			this.logger.debug(`Clicking on element: ${elementToClick}`)

			await this.page.click(elementToClick)

			if (!elementToWait) return

			this.logger.debug(`And then waiting for element: ${elementToWait}`)

			if (!timeToWait) {
				await this.page.waitForSelector(elementToWait, { timeout: 120000 })

				return
			}

			await this.page.waitForSelector(elementToWait, { timeout: timeToWait })
		} catch (err) {
			this.logger.error(`Error on click: ${err}`)
			await this.takeScreenshot(true)
		}
	}

	async hover(elementToHover, elementToWait, timeToWait) {
		try {
			this.logger.debug(`Hovering on element: ${elementToHover}`)

			await this.page.hover(elementToHover)

			if (!elementToWait) return

			this.logger.debug(`And then waiting for element: ${elementToWait}`)

			if (!timeToWait) await this.page.waitForSelector(elementToWait, { timeout: 120000 })
			else await this.page.waitForSelector(elementToWait, { timeout: timeToWait })
		} catch (err) {
			this.logger.error(`Error on hover: ${err}`)
			await this.takeScreenshot(true)
		}
	}

	async typeInput(elementToType, textToType, maxRandomTimeMs) {
		try {
			this.logger.info(`Typying text on ${elementToType}`)
			await this.page.focus(elementToType)
			const min = 500
			const max = maxRandomTimeMs || 5000
			for (let i = 0; i < textToType.length; i += 1) {
				const random = new Random()
				const randomSleepMs = random.real(min, max)
				const char = textToType.charAt(i)
				await this.page.type(elementToType, char)
				await this.logger.debug(`Typying char ${char}`)
				await this.cawer.msleep(randomSleepMs)
			}
		} catch (err) {
			this.logger.error(`Error on typeInput: ${err}`)
			await this.takeScreenshot(true)
		}
	}

	async reload() {
		await this.navigateTo(this.page.url())
	}

	async getTotalBytesReceived() {
		try {
			const result = await this.page.evaluate(() => JSON.stringify(performance.getEntries()))
			const bytesReceived = this.cawer.formatBytes((JSON.parse(result))
				.reduce((total, item) => total + (item.transferSize !== undefined ? item.transferSize : 0), 0))

			return bytesReceived
		} catch (err) {
			this.logger.error(`Error on getPerformanceEntries: ${err}`)

			await this.takeScreenshot(true)
		}

		return false
	}

	/**
	* Scrape a page using puppeter or axios+cheerio
	* @param {Object} options Options to scrape,
	* @return {Object} element/script scraped/evaluated
	params accepted: element, script, evaluate, waitForElement, url
	*/
	scrape(options) {
		// element, script, waitForElement, url
		if (options.script) {
			return this.evaluate(options.script, options.waitForElement)
		} if (options.element) {
			return this.scrapeElement(options.url, options.element)
		}

		this.logger(`Insuficient parameters for scrape method. options: ${JSON.stringify(options)}`)

		return {}
	}

	async scrapeElement(url, element) {
		// TODO ter base de useragent (helper)
		const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.122 Safari/537.36' } })
		const $ = cheerio.load(response.data)
		let content = ''
		content = $(`${element}`)

		return content
	}

	async evaluate(scriptToEvaluate, waitForElement) {
		try {
			this.logger.info(`Evaluating: ${scriptToEvaluate}`)

			if (waitForElement) {
				this.logger.info(`but first waiting for element ${waitForElement}`)
				await this.page.waitForSelector(waitForElement, { timeout: 120000 })
			}

			// async use inside strings is necessary to fix errors if app is packaged with pkg.
			// if pkg not necessary, just use normal evaluate

			// * normal evaluate
			// const evaluateResult = await page.evaluate(() =>
			// Array.from(document.querySelectorAll('.result__a')).map((item) => item.innerText));
			const evaluateResult = await this.page.evaluate(`(async() => {
				return ${scriptToEvaluate}
	  	})()`)

			return evaluateResult
		} catch (err) {
			this.logger.error(`Error on evaluate: ${err}`)

			await this.takeScreenshot(true)
			await this.saveFullHtmlContent(true)
		}

		return false
	}

	downloadFile(url) {
		download(url, defaults.downloadPath)
			.then(() => {
				this.logger.notice('done downloading!')
			})
	}

	async closeBrowser(cookiesFilePath = false) {
		if (cookiesFilePath) await this.saveCookies(cookiesFilePath)

		await this.page.close()
		await this.browser.close()
	}

	async scrollPage(scrollCount) {
		while (true) {
			try {
				for (let i = 0; i < scrollCount; i += 1) {
					console.log(`[${i + 1}/${scrollCount}] scrolling...`)
					await this.page.evaluate(() => {
						window.scrollBy(0, window.innerHeight)
						window.scrollTo(0, document.body.scrollHeight)
					})

					this.cawer.sleep(3)
				}
			} catch (error) {
				this.logger.error(`Error on scrolling: ${error}\ntrying again in 30 seconds`)
				this.cawer.sleep(30)
			}

			break
		}
	}

	async takeScreenshot(isError = false, path = undefined) {
		try {
			this.logger.warn('Taking screenshot...')

			const matches = this.url.match(/^https?\:\/\/(?:www\.)?([^\/?#]+)(?:[\/?#]|$)/i)
			const domain = matches && matches[1]
			const todayDate = await moment()
				.format('YYYY-MM-DDTHH-mm-ss-SSS')
			let pathToSaveScreenshot = ''

			if (isError) {
				const folderPath = process.mainModule.paths[0].split('node_modules')[0].slice(0, -1)

				pathToSaveScreenshot = `${folderPath}/../${defaults.screenshotsDir}/${domain}_${todayDate}_error.png`
			} else {
				pathToSaveScreenshot = `${path}/${todayDate}_error.png`
			}

			await this.page.screenshot({
				path: pathToSaveScreenshot,
				fullPage: true,
			})

			this.logger.warn(`Screenshot saved: ${pathToSaveScreenshot}`)
		} catch (err) {
			this.logger.error(`Error on takeScreenshot: ${err}`)
		}
	}

	async saveFullHtmlContent(isError = false, path = undefined) {
		try {
			this.logger.warn('Saving full html content...')

			const matches = this.url.match(/^https?\:\/\/(?:www\.)?([^\/?#]+)(?:[\/?#]|$)/i)
			const domain = matches && matches[1]
			const bodyHTML = await this.page.evaluate(() => document.body.innerHTML)
			const todayDate = await moment()
				.format('YYYY-MM-DDTHH-mm-ss-SSS')
			let pathToSaveHTML = ''

			if (isError) {
				const folderPath = process.mainModule.paths[0].split('node_modules')[0].slice(0, -1)

				pathToSaveHTML = `${folderPath}/../${defaults.fullHTMLDir}/${domain}_${todayDate}.txt`
			} else {
				pathToSaveHTML = `${path}/${todayDate}_error.png`
			}

			fs.writeFileSync(pathToSaveHTML, bodyHTML)

			this.logger.warn(`Full HTML saved: ${pathToSaveHTML}`)
		} catch (err) {
			this.logger.error(`Error on saveFullHtmlContent: ${err}`)
		}
	}

}

module.exports = Spidering
