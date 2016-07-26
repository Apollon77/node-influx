'use strict'

const Pool = require('./pool')
const url = require('url')
const _ = require('lodash')

const defaultHost = Object.freeze({
  host: '127.0.0.1',
  protocol: 'http',
  port: 8086
})

const defaultOptions = Object.freeze(_.assign({
  hosts: [],
  timePrecision: 'ms',
  username: 'root',
  password: 'root'
}, defaultHost))

/**
 * @typedef {Object} HostConfig
 * @property {String} [host=127.0.0.1] Influx host to connect to
 * @property {String} [port=8086] port to connect to on the host
 * @property {String} [protocol=http] protocol to connect with
 */

/**
 * A DataTuple is a one or two element array containing data to be inserted
 * into Influx. Its first element defines values, and the second element
 * defines tags to insert. Generally these are passed in as objects,
 * though either may be omitted to omit tags or values.
 * @typedef {Array} DataTuple
 * @example
 * // Expands to `INSERT series,host=server01 value=0.67`:
 * [{ value: 0.67 }, { host: 'server01' }]
 * // All of these expand to `INSERT series value=0.67`:
 * [{ value: 0.67 }]
 * [{ value: 0.67 }, undefined]
 * [{ value: 0.67 }, null]
 * [{ value: 0.67 }, {}]
 * // All of these expand to `INSERT series,host=server01`:
 * [undefined, { host: 'server01' }]
 * [null, { host: 'server01' }]
 * [{}, { host: 'server01' }]
 */

/**
 * Parses the URL out into into a HostConfig object
 * @param  {String} addr
 * @return {HostConfig}
 */
function parseOptionsUrl (addr) {
  const parsed = url.parse(addr)
  const options = {
    host: parsed.hostname,
    port: parsed.port,
    protocol: parsed.protocol
  }

  if (parsed.auth) {
    const authSplit = parsed.auth.split(':')
    options.username = authSplit[0]
    options.password = authSplit[1]
  }

  if (parsed.pathname.length > 1) {
    options.database = parsed.pathname.slice(1)
  }

  return options
}

/**
 * InfluxDB is the primary means of querying the database.
 * @public
 */
class InfluxDB {

  /**
   * Creates a new InfluxDB instance.
   * @param {Object|String} options options object or address to an Influx instance
   * @param {String} [options.host=127.0.0.1] Influx host to connect to
   * @param {String} [options.port=8086] port to connect to on the host
   * @param {String} [options.username=root] optional username for authentication
   * @param {String} [options.password=root] optional password for authentication
   * @param {String} [options.protocol=http] protocol to connect with
   * @param {String} [options.database] default database for queries
   * @param {HostConfig[]} [hosts] Optionally you may pass an array of host
   *     objects, each containing a username, password, and protocol. If
   *     you pass this, you must NOT pass a username, password, or
   *     protocol as a top-level item.
   * @return {InfluxDB}
   */
  constructor (options) {
    // 1. See if the user is passing a URI directly in. Parse it out if so.
    if (typeof options === 'string') {
      options = parseOptionsUrl(options)
    }

    // 2. Fill in default options. If the user is passing a top-level host,
    // nest it into hosts array for parsing.
    options = _.defaults({}, options, defaultOptions)
    if (options.hosts.length === 0) {
      options.hosts.push(_.pick(options, ['username', 'password', 'protocol']))
    }

    // 3. Instantiate the pool and save the options. Liftoff!
    this._options = options
    this._pool = new Pool(options.pool)

    options.hosts.forEach(host => {
      if (typeof host === 'string') {
        host = parseOptionsUrl(host)
      }

      this._pool.addHost(
        host.host || defaultHost.host,
        host.port || defaultHost.port,
        host.protocol || defaultHost.protocol
      )
    })
  }

  _parseResults (response, callback) {
    var results = []
    _.each(response, function (result) {
      var tmp = []
      if (result.series) {
        _.each(result.series, function (series) {
          var rows = _.map(series.values, function (values) {
            return _.extend(_.zipObject(series.columns, values), series.tags)
          })
          tmp = _.chain(tmp).concat(rows).value()
        })
      }
      results.push(tmp)
    })
    return callback(null, results)
  }

  _parseCallback (callback) {
    return function (err, res, body) {
      if (typeof callback === 'undefined') return
      if (err) {
        return callback(err)
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return callback(new Error(body.error || body))
      }

      if (_.isObject(body) && body.results && _.isArray(body.results)) {
        for (var i = 0; i <= body.results.length; ++i) {
          if (body.results[i] && body.results[i].error && body.results[i].error !== '') {
            return callback(new Error(body.results[i].error))
          }
        }
      }
      if (body === undefined) {
        return callback(new Error('body is undefined'))
      }
      return callback(null, body.results)
    }
  }

  /**
   * Formats a URL to query an influx resource.
   * @private
   * @param  {String} endpoint
   * @param  {Object} options
   * @param  {String} options.database database to query
   * @param  {String} options.rp retention policy to query
   * @param  {String} options.precision time precision to operate at
   * @param  {Object} query free-form query string data
   * @return {String}
   */
  _url (endpoint, options, query) {
    // prepare the query object
    var queryObj = _.extend({
      u: this._options.username,
      p: this._options.password
    }, options, query)

    // add the global configuration if they are set and not provided by the options
    if (this._options.timePrecision && !queryObj.precision) {
      queryObj.precision = this._options.timePrecision
    }
    if (this._options.database && !queryObj.db) {
      queryObj.db = this._options.database
    }
    if (this._options.retentionPolicy && !queryObj.rp) {
      queryObj.rp = this._options.retentionPolicy
    }

    return url.format({
      pathname: endpoint,
      query: queryObj
    })
  }

  // Prepares and sends the actual request
  _queryDB (query, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }

    this._pool.get({
      url: this._url('query', options, { q: query }),
      json: true
    }, this._parseCallback(callback))
  }

  // creates a new database
  createDatabase (databaseName, callback) {
    this._queryDB('create database "' + databaseName + '"', callback)
  }

  dropDatabase (databaseName, callback) {
    this._queryDB('drop database "' + databaseName + '"', callback)
  }

  getDatabaseNames (callback) {
    this._queryDB('show databases', function (err, results) {
      if (err) {
        return callback(err, results)
      }
      return callback(err, _.map(results[0].series[0].values, a => a[0]))
    })
  }

  getMeasurements (callback) {
    this._queryDB('show measurements', callback)
  }

  getSeriesNames (measurementName, callback) {
    var query = 'show series'

    // if no measurement name is given
    if (typeof measurementName === 'function') {
      callback = measurementName
    } else {
      query = query + ' from "' + measurementName + '"'
    }

    this._queryDB(query, function (err, results) {
      if (err) {
        return callback(err, results)
      }
      return callback(err, _.map(results[0].series, function (series) { return series.name }))
    })
  }

  getSeries (measurementName, callback) {
    var query = 'show series'

    // if no measurement name is given
    if (typeof measurementName === 'function') {
      callback = measurementName
    } else {
      query = query + ' from "' + measurementName + '"'
    }

    this._queryDB(query, function (err, results) {
      if (err) {
        return callback(err, results)
      }
      return callback(err, results[0].series)
    })
  }

  dropMeasurement (measurementName, callback) {
    this._queryDB('drop measurement "' + measurementName + '"', callback)
  }

  dropSeries (seriesId, callback) {
    this._queryDB('drop series ' + seriesId, callback)
  }

  getUsers (callback) {
    this._queryDB('show users', (err, results) => {
      if (err) {
        return callback(err, results)
      }
      this._parseResults(results, function (err, results) {
        return callback(err, results[0])
      })
    })
  }

  createUser (username, password, isAdmin, callback) {
    if (typeof isAdmin === 'function') {
      callback = isAdmin
      isAdmin = false
    }
    var query = 'create user "' + username + '" with password \'' + password + "'"
    if (isAdmin) {
      query += ' with all privileges'
    }
    this._queryDB(query, callback)
  }

  setPassword (username, password, callback) {
    this._queryDB('set password for "' + username + '" = \'' + password + "'", callback)
  }

  grantPrivilege (privilege, databaseName, userName, callback) {
    this._queryDB('grant ' + privilege + ' on "' + databaseName + '" to "' + userName + '"', callback)
  }

  revokePrivilege (privilege, databaseName, userName, callback) {
    this._queryDB('revoke ' + privilege + ' on "' + databaseName + '" from "' + userName + '"', callback)
  }

  grantAdminPrivileges (userName, callback) {
    this._queryDB('grant all privileges to "' + userName + '"', callback)
  }

  revokeAdminPrivileges (userName, callback) {
    this._queryDB('revoke all privileges from "' + userName + '"', callback)
  }

  dropUser (username, callback) {
    this._queryDB('drop user "' + username + '"', callback)
  }

  _createKeyValueString (object) {
    var output = []
    _.forOwn(object, function (value, key) {
      if (typeof value === 'string') {
        output.push(key + '="' + value + '"')
      } else {
        output.push(key + '=' + value)
      }
    })
    return output.join(',')
  }

  _createKeyTagString (object) {
    var output = []
    _.forOwn(object, function (value, key) {
      if (typeof value === 'string') {
        output.push(key + '=' + value.replace(/ /g, '\\ ').replace(/,/g, '\\,').replace(/=/g, '\\='))
      } else {
        output.push(key + '=' + value)
      }
    })
    return output.join(',')
  }

  _prepareValues (series) {
    var output = []
    _.forEach(series, (values, seriesName) => {
      _.each(values, (points) => {
        var line = seriesName.replace(/ /g, '\\ ').replace(/,/g, '\\,')
        if (points[1] && _.isObject(points[1]) && _.keys(points[1]).length > 0) {
          line += ',' + this._createKeyTagString(points[1])
        }

        if (_.isObject(points[0])) {
          var timestamp = null
          if (points[0].time) {
            timestamp = points[0].time
            delete (points[0].time)
          }
          line += ' ' + this._createKeyValueString(points[0])
          if (timestamp) {
            if (timestamp instanceof Date) {
              line += ' ' + timestamp.getTime()
            } else {
              line += ' ' + timestamp
            }
          }
        } else {
          if (typeof points[0] === 'string') {
            line += ' value="' + points[0] + '"'
          } else {
            line += ' value=' + points[0]
          }
        }
        output.push(line)
      }, this)
    }, this)
    return output.join('\n')
  }

  /**
   * Writes multiple points into multiple database series.
   *
   * @param  {Object.<String, DataTuple>} series map of series names to points
   *     arrays, see {@link InfluxDB#writePoints} for an example.
   * @param  {Object} [options]
   * @param  {String} [options.precision=ms]
   * @param  {Function} callback [description]
   * @example
   * writeSeries({
   *   cpu_load_short: [
   *     [{ value: 0.67 }, { host: 'server01' }],
   *     [{ value: 0.42 }, { host: 'server02' }]
   *   ],
   *   temperature: [
   *     [{ internal: 42, external: 23 }, { machine: 'unit64'}],
   *   ],
   * })
   */
  writeSeries (series, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }

    if (!options.database) {
      options.database = this._options.database
    }

    if (!options.precision) {
      options.precision = this._options.timePrecision
    }

    this._pool.post({
      url: this._url('write', options),
      pool: typeof options.pool !== 'undefined' ? options.pool : {},
      body: this._prepareValues(series)
    }, this._parseCallback(callback))
  }

  /**
   * Writes a point to a series.
   *
   * @param  {String} seriesName
   * @param  {Object.<String, *>} [values]
   * @param  {Object.<String, String>} [tags]
   * @param  {Object} [options]
   * @param  {String} [options.precision=ms]
   * @param  {Function} callback
   * @example
   * // Write a single point with two values and a tags, inserting at the current time.
   * client.writePoint('temperature', { internal: 42, external: 23 }, { machine: 'unit64' }, done)
   *
   * // Write a single point, providing an integer timestamp and time precision 's' for seconds
   * client.writePoint('cpu', { time: 1465698009, value: 0.67 }, { machine: 'unit64' }, { precision : 's' }, done)
   *
   * // Write a single point, providing a Date object. Precision is set to default 'ms' for milliseconds.
   * client.writePoint('cpu', { time: new Date(), value: 0.67 }, { machine: 'unit64' }, null, done)
   */
  writePoint (seriesName, values, tags, options, callback) {
    this.writePoints(seriesName, [[values, tags]], options, callback)
  }

  /**
   * Writes multiple points into a series.
   *
   * @param  {String} seriesName
   * @param  {DataTuple[]} points
   * @param  {Object} [options]
   * @param  {String} [options.precision=ms]
   * @param  {Function} callback
   * @example
   * const points = [
   *   // Write a value of 0.67 under the tag machine=unit64
   *   [{ value: 0.67 }, { machine: 'unit64' }],
   *   // Write a value at a specified date, and omit tags.
   *   [{ value: 122, time: new Date('Sat Jun 11 2016 19:26:58 GMT-0700 (PDT)') }]
   *   // Write a tag-only row in, omitting any values.
   *   [null, { machine: 'unit64' }]
   * ]
   * client.writePoints(series, points, [options,] callback)
   */
  writePoints (seriesName, points, options, callback) {
    this.writeSeries({ [seriesName]: points }, options, callback)
  }

  /**
   * Queries the database and returns an array of parsed responses.
   * @param  {String}   [databaseName]
   * @param  {String}   query
   * @param  {Function} callback
   */
  query (databaseName, query, callback) {
    this.queryRaw(query, { db: databaseName }, (err, results) => {
      if (err) {
        return callback(err, results)
      }

      return this._parseResults(results, callback)
    })
  }

  /**
   * Same as function `query` but returns the raw response from InfluxDB
   * without any additional parsing.
   * @param  {String}   databaseName
   * @param  {String}   query
   * @param  {Function} callback
   */
  queryRaw (databaseName, query, callback) {
    if (typeof query === 'function') {
      callback = query
      query = databaseName
      databaseName = this._options.database
    }
    this._queryDB(query, { db: databaseName }, callback)
  }

  /**
   * Creates a continuous query - requires admin privileges
   * @param  {String}   queryName
   * @param  {String}   queryString
   * @param  {String}   databaseName
   * @param  {Function} callback
   * @example
   * client.createContinuousQuery('testQuery', `
   *   SELECT COUNT(value) INTO valuesCount_1h
   *   FROM ${info.series.name} GROUP BY time(1h)
   * `, (err, res) => {})
   */
  createContinuousQuery (queryName, queryString, databaseName, callback) {
    if (typeof databaseName === 'function') {
      callback = databaseName
      databaseName = this._options.database
    }

    const query = `CREATE CONTINUOUS QUERY ${queryName} ON "${databaseName}"
      BEGIN  ${queryString} END`
    this._queryDB(query, callback)
  }

  /**
   * Fetches all continuous queries from a database - requires database admin privileges
   * @param  {Function} callback
   * @example
   * getContinuousQueries((err,arrayContinuousQueries) => {})
   */
  getContinuousQueries (callback) {
    this._queryDB('SHOW CONTINUOUS QUERIES', (err, result) => {
      if (err) return callback(err)
      this._parseResults(result, callback)
    })
  }

  /**
   * Drops a continuous query from a database - requires database admin privileges
   * @param  {String}   queryName
   * @param  {String}   [databaseName]
   * @param  {Function} callback
   */
  dropContinuousQuery (queryName, databaseName, callback) {
    if (typeof databaseName === 'function') {
      callback = databaseName
      databaseName = this._options.database
    }
    this._queryDB(`DROP CONTINUOUS QUERY "${queryName}" ON "${databaseName}"`, callback)
  }

  /**
   * Creates a new retention policy - requires admin privileges.
   * @param  {String}   rpName
   * @param  {String}   databaseName
   * @param  {String}   duration
   * @param  {String}   replication
   * @param  {Boolean}  isDefault
   * @param  {Function} callback
   */
  createRetentionPolicy (rpName, databaseName, duration, replication, isDefault, callback) {
    let query = `create retention policy "${rpName}" on "${databaseName}"
      duration ${duration} replication ${replication}`

    if (isDefault) {
      query += ' default'
    }

    this._queryDB(query, callback)
  }

  /**
   * Fetches all retention policies from a database.
   * @param  {String}   databaseName
   * @param  {Function} callback
   */
  getRetentionPolicies (databaseName, callback) {
    this._queryDB(`show retention policies on "${databaseName}"`, callback)
  }

  /**
   * Alters an existing retention policy - requires admin privileges.
   * @param  {String}   rpName
   * @param  {String}   databaseName
   * @param  {String}   duration
   * @param  {String}   replication
   * @param  {Boolean}  isDefault
   * @param  {Function} callback
   */
  alterRetentionPolicy (rpName, databaseName, duration, replication, isDefault, callback) {
    let query = `alter retention policy "${rpName}" on "${databaseName}"`

    if (duration) {
      query += ' duration ' + duration
    }
    if (replication) {
      query += ' replication ' + replication
    }
    if (isDefault) {
      query += ' default'
    }

    this._queryDB(query, callback)
  }

  /**
   * Returns a list of currently active hosts.
   * @return {Host[]}
   */
  getHostsAvailable () {
    return this._pool.getHostsAvailable()
  }

  /**
   * Returns a list of hosts that are currently disabled due to network
   * errors.
   * @return {Host[]}
   */
  getHostsDisabled () {
    return this._pool.getHostsDisabled()
  }
}

module.exports = InfluxDB
module.exports.InfluxDB = InfluxDB // some backwards compatibility
