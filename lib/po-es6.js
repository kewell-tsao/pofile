'use strict'
// jscs:disable validateIndentation
// jscs:disable disallowSpacesInFunctionDeclaration
// jscs:disable requireSpacesInsideObjectBrackets
const fs = require('fs')

class PO {
  constructor () {
    this.comments = []
    this.extractedComments = []
    this.headers = {}
    this.headerOrder = []
    this.items = []
  }

  save (filename, callback) {
    let stream = fs.createWriteStream(filename)
    let streamEnd = false
    let iterator = this.toLines()

    let errorHandler = function (err) {
      streamEnd = true
      callback(err)
    }
    stream.once('error', errorHandler)

    let writeNext
    (writeNext = function () {
      while (!streamEnd) {
        let n = iterator.next()
        if (n && n.done) {
          streamEnd = true
          stream.end()
          callback()
          break
        }
        if (!stream.write(n.value + '\n', 'utf-8')) {
          stream.once('drain', writeNext)
          break
        }
      }
    })()
  }

  saveAsync (filename) {
    return new Promise((resolve, reject) => {
      this.save(filename, err => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  toString () {
    let lines = Array.from(this.toLines())
    return lines.join('\n')
  }

  *toLines () {
    if (this.comments) {
      for (let comment of this.comments) {
        // Fix: keep the first space
        yield ('# ' + (isString(comment) ? comment.trim() : ''))
      }
    }

    if (this.extractedComments) {
      for (let comment of this.extractedComments) {
        // Fix: keep the first space
        yield ('#. ' + (isString(comment) ? comment.trim() : ''))
      }
    }

    yield 'msgid ""'
    yield 'msgstr ""'

    let headerOrder = []

    this.headerOrder.forEach(key => {
      if (key in this.headers) {
        headerOrder.push(key)
      }
    })

    let keys = Object.keys(this.headers)

    keys.forEach(key => {
      if (headerOrder.indexOf(key) === -1) {
        headerOrder.push(key)
      }
    })

    for (let key of headerOrder) {
      yield ('"' + key + ': ' + this.headers[key] + '\\n"')
    }
    yield ''

    for (let item of this.items) {
      yield* item.toLines()
      yield ''
    }
  }

  static load (filename, callback) {
    fs.readFile(filename, 'utf-8', function (err, data) {
      if (err) {
        return callback(err)
      }
      let po = PO.parse(data)
      callback(null, po)
    })
  }

  static loadAsync (filename) {
    return new Promise((resolve, reject) => {
      PO.load(filename, err => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  static parse (data) {
    //support both unix and windows newline formats.
    data = data.replace(/\r\n/g, '\n')
    let po = new PO()
    let sections = data.split(/\n\n/)
    let headers = []
    //everything until the first 'msgid ""' is considered header
    while (sections[0] && (headers.length === 0 || headers[headers.length - 1].indexOf('msgid ""') < 0)) {
      if (sections[0].match(/msgid "[^"]/)) {
        //found first real string, adding a dummy header item
        headers.push('msgid ""')
      } else {
        headers.push(sections.shift())
      }
    }
    headers = headers.join('\n')
    let lines = sections.join('\n').split(/\n/)

    po.headers = {
      'Project-Id-Version': '',
      'Report-Msgid-Bugs-To': '',
      'POT-Creation-Date': '',
      'PO-Revision-Date': '',
      'Last-Translator': '',
      'Language': '',
      'Language-Team': '',
      'Content-Type': '',
      'Content-Transfer-Encoding': '',
      'Plural-Forms': '',
    }
    po.headerOrder = []

    headers.split(/\n/).reduce(function (acc, line) {
      if (acc.merge) {
        //join lines, remove last resp. first "
        line = acc.pop().slice(0, -1) + line.slice(1)
        delete acc.merge
      }
      if (/^".*"$/.test(line) && !/^".*\\n"$/.test(line)) {
        acc.merge = true
      }
      acc.push(line)
      return acc
    }, []).forEach(function (header) {
      if (header.match(/^#\./)) {
        po.extractedComments.push(header.replace(/^#\.\s*/, ''))
      } else if (header.match(/^#/)) {
        po.comments.push(header.replace(/^#\s*/, ''))
      } else if (header.match(/^"/)) {
        header = header.trim().replace(/^"/, '').replace(/\\n"$/, '')
        let p = header.split(/:/)
        let name = p.shift().trim()
        let value = p.join(':').trim()
        po.headers[name] = value
        po.headerOrder.push(name)
      }
    })

    let parsedPluralForms = PO.parsePluralForms(po.headers['Plural-Forms'])
    let nplurals = parsedPluralForms.nplurals
    let item = new PO.Item({nplurals: nplurals})
    let context = null
    let plural = 0
    let obsoleteCount = 0
    let noCommentLineCount = 0

    function finish () {
      if (item.msgid.length > 0) {
        if (obsoleteCount >= noCommentLineCount) {
          item.obsolete = true
        }
        obsoleteCount = 0
        noCommentLineCount = 0
        po.items.push(item)
        item = new PO.Item({nplurals: nplurals})
      }
    }

    function extract (string) {
      string = trim(string)
      string = string.replace(/^[^"]*"|"$/g, '')
      string = string.replace(/\\([abtnvfr'"\\?]|([0-7]{3})|x([0-9a-fA-F]{2}))/g, function (match, esc, oct, hex) {
        if (oct) {
          return String.fromCharCode(parseInt(oct, 8))
        }
        if (hex) {
          return String.fromCharCode(parseInt(hex, 16))
        }
        switch (esc) {
          case 'a':
            return '\x07'
          case 'b':
            return '\b'
          case 't':
            return '\t'
          case 'n':
            return '\n'
          case 'v':
            return '\v'
          case 'f':
            return '\f'
          case 'r':
            return '\r'
          default:
            return esc
        }
      })
      return string
    }

    while (lines.length > 0) {
      let line = trim(lines.shift())
      let lineObsolete = false
      let add = false

      if (line.match(/^#\~/)) { // Obsolete item
        //only remove the obsolte comment mark, here
        //might be, this is a new item, so
        //only remember, this line is marked obsolete, count after line is parsed
        line = trim(line.substring(2))
        lineObsolete = true
      }

      if (line.match(/^#:/)) { // Reference
        finish()
        item.references.push(trim(line.replace(/^#:/, '')))
      } else if (line.match(/^#,/)) { // Flags
        finish()
        let flags = trim(line.replace(/^#,/, '')).split(',')
        for (let i = 0; i < flags.length; i++) {
          item.flags[flags[i]] = true
        }
      } else if (line.match(/^#($|\s+)/)) { // Translator comment
        finish()
        item.comments.push(trim(line.replace(/^#($|\s+)/, '')))
      } else if (line.match(/^#\./)) { // Extracted comment
        finish()
        item.extractedComments.push(trim(line.replace(/^#\./, '')))
      } else if (line.match(/^msgid_plural/)) { // Plural form
        item.msgid_plural = extract(line)
        context = 'msgid_plural'
        noCommentLineCount++
      } else if (line.match(/^msgid/)) { // Original
        finish()
        item.msgid = extract(line)
        context = 'msgid'
        noCommentLineCount++
      } else if (line.match(/^msgstr/)) { // Translation
        let m = line.match(/^msgstr\[(\d+)\]/)
        plural = m && m[1] ? parseInt(m[1]) : 0
        item.msgstr[plural] = extract(line)
        context = 'msgstr'
        noCommentLineCount++
      } else if (line.match(/^msgctxt/)) { // Context
        finish()
        item.msgctxt = extract(line)
        context = 'msgctxt'
        noCommentLineCount++
      } else { // Probably multiline string or blank
        if (line.length > 0) {
          noCommentLineCount++
          if (context === 'msgstr') {
            item.msgstr[plural] += extract(line)
          } else if (context === 'msgid') {
            item.msgid += extract(line)
          } else if (context === 'msgid_plural') {
            item.msgid_plural += extract(line)
          } else if (context === 'msgctxt') {
            item.msgctxt += extract(line)
          }
        }
      }

      if (lineObsolete) {
        // Count obsolete lines for this item
        obsoleteCount++
      }
    }
    finish()

    return po
  }

  static parsePluralForms (pluralFormsString) {
    let results = (pluralFormsString || '')
      .split(';')
      .reduce(function (acc, keyValueString) {
        let trimmedString = keyValueString.trim()
        let equalsIndex = trimmedString.indexOf('=')
        let key = trimmedString.substring(0, equalsIndex).trim()
        let value = trimmedString.substring(equalsIndex + 1).trim()
        acc[key] = value
        return acc
      }, {})
    return {
      nplurals: results.nplurals,
      plural: results.plural
    }
  }
}

class POItem {
  constructor (options) {
    let nplurals = options && options.nplurals
    this.msgid = ''
    this.msgctxt = null
    this.references = []
    this.msgid_plural = null
    this.msgstr = []
    this.comments = [] // translator comments
    this.extractedComments = []
    this.flags = {}
    this.obsolete = false
    let npluralsNumber = Number(nplurals)
    this.nplurals = (isNaN(npluralsNumber)) ? 2 : npluralsNumber
  }

  toString () {
    let lines = Array.from(this.toLines())
    return lines.join('\n')
  }

  *toLines () {
    // https://www.gnu.org/software/gettext/manual/html_node/PO-Files.html
    // says order is translator-comments, extracted-comments, references, flags
    for (let c of this.comments) {
      yield ('# ' + c)
    }

    for (let c of this.extractedComments) {
      yield ('#. ' + c)
    }

    for (let ref of this.references) {
      yield ('#: ' + ref)
    }

    let flags = Object.keys(this.flags).filter(flag => !!this.flags[flag], this)
    if (flags.length > 0) {
      yield ('#, ' + flags.join(','))
    }
    let mkObsolete = this.obsolete ? '#~ ' : ''

    for (let keyword of ['msgctxt', 'msgid', 'msgid_plural', 'msgstr']) {
      let text = this[keyword]
      if (text != null) {
        let hasTranslation = false
        if (Array.isArray(text)) {
          hasTranslation = text.some(text => text)
        }

        if (Array.isArray(text) && text.length > 1) {
          for (let i = 0; i < text.length; i++) {
            let t = text[i]
            let processed = _processLineBreak(keyword, t, i)
            yield (mkObsolete + processed.join('\n' + mkObsolete))
          }
        } else if (this.msgid_plural && keyword === 'msgstr' && !hasTranslation) {
          for (let pluralIndex = 0; pluralIndex < this.nplurals; pluralIndex++) {
            yield (mkObsolete + _process(keyword, '', pluralIndex))
          }
        } else {
          let index = (this.msgid_plural && Array.isArray(text)) ? 0 : undefined
          text = Array.isArray(text) ? text.join() : text
          let processed = _processLineBreak(keyword, text, index)
          yield (mkObsolete + processed.join('\n' + mkObsolete))
        }
      }
    }
  }
}

PO.Item = POItem

// reverse what extract(string) method during PO.parse does
function _escape (string) {
  // don't unescape \n, since string can never contain it
  // since split('\n') is called on it
  string = string.replace(/[\x07\b\t\v\f\r"\\]/g, function (match) {
    switch (match) {
      case '\x07':
        return '\\a'
      case '\b':
        return '\\b'
      case '\t':
        return '\\t'
      case '\v':
        return '\\v'
      case '\f':
        return '\\f'
      case '\r':
        return '\\r'
      default:
        return '\\' + match
    }
  })
  return string
}

function _process (keyword, text, i) {
  let lines = []
  let parts = text.split(/\n/)
  // Fix: remove empty end line
  if (text[text.length - 1] === '\n' && parts[parts.length - 1] === '') {
    parts.pop()
  }
  let index = typeof i !== 'undefined' ? '[' + i + ']' : ''
  if (parts.length > 1) {
    lines.push(keyword + index + ' ""')
    parts.forEach(function (part) {
      lines.push('"' + _escape(part) + '"')
    })
  } else {
    lines.push(keyword + index + ' "' + _escape(text) + '"')
  }
  return lines
}

// handle \n in single-line texts (can not be handled in _escape)
function _processLineBreak (keyword, text, index) {
  let processed = _process(keyword, text, index)
  for (let i = 1; i < processed.length - 1; i++) {
    processed[i] = processed[i].slice(0, -1) + '\\n"'
  }
  return processed
}

function trim (string) {
  return string.replace(/^\s+|\s+$/g, '')
}

function isString (value) {
  return typeof value === 'string'
}

module.exports = PO