const getPixels = require('get-pixels')
const getRgbaPalette = require('get-rgba-palette')
const chroma = require('chroma-js')
const getSvgColors = require('get-svg-colors')
const pify = require('pify')

function paletteFromBitmap (filename, options, callback) {
  if (!options) {
    options = {}
  }
  if (!callback) {
    callback = options
    options = {}
  }
  getPixels(filename, options.type, function (err, pixels) {
    if (err) return callback(err)
    const hues = getHues(pixels.data, options.count, options.quality, options.filter)
    const palette = getRgbaPalette(pixels.data, options.count, options.quality, options.filter)
    console.log("palette", palette)
    callback(null, {path: filename, hues: hues, palette: palette})
  })
}

function defaultFilter (pixels, index) {
  return pixels[index + 3] >= 127
}

function getHues(pixels, count, quality, filter) {
  count = typeof count === 'number' ? (count|0) : 5
  quality = typeof quality === 'number' ? (quality|0) : 10
  filter = typeof filter === 'function' ? filter : defaultFilter
  if (quality <= 0)
    throw new Error('quality must be > 0')

    // Store the RGB values in an array format suitable for quantize function
    var pixelArray = []
    var step = 4*quality

    var huebins = {}
    var lightnessSum = 0
    var lightPixelCount = 0
    var totalPixels = (pixels.length/step)
    var totalHuedPixels_c = 0
    var totalHuedPixels = 0

    var HUE_BIN_SIZE = 3

    for (var i=0, len=pixels.length; i<len; i+=step) {
      var r = pixels[i + 0]
      var g = pixels[i + 1]
      var b = pixels[i + 2]

      // if the pixel passes the filter function
      if (!filter(pixels, i, pixels)) {
        continue
      }
      var hslc = rgbToHslc(r,g,b)
      var h = hslc[0]
      var s = hslc[1]
      var l = hslc[2]
      var c = hslc[3]

      // black and white don't have real hue
      lightnessSum += l
      if (l > 0.75) {
        lightPixelCount++
      }
      var hue = HUE_BIN_SIZE*Math.floor((360/HUE_BIN_SIZE)*h)
      var sat = Math.floor(s*100)
      var lite = Math.floor(l*100)
      // console.log(`hsl(${hue},${sat},${lite})`)
      // console.log(`hsl(${hue},${sat}%,${lite}%)`)
      if (s < 0.2 || l < 0.1 || l > 0.9) {
      // if (s < 0.4 || l < 0.1 || l > 0.9) {
        continue
      // } else if (s < 0.4 || l < 0.2) {
        // console.log(`kinda grey: rgb(${r},${g},${b}) = hsl(${hue},${sat}%,${lite}%)`)
      }

      huebins[hue] = (huebins[hue] || {
        hue: hue,
        totals: {
          px: 0,
          c: 0,
          s: 0,
          l: 0
        }
      })
      huebins[hue].totals.px += 1
      huebins[hue].totals.c += c // chroma
      huebins[hue].totals.s += s // saturation
      huebins[hue].totals.l += l // lightness

      totalHuedPixels++
      totalHuedPixels_c += c

      // TODO = try keeping the code the same, except quantize on HSL instead of RGB?
          // maybe do this but with fewer SL bins than H bins?
      // https://softwareengineering.stackexchange.com/questions/186657/how-is-a-256-bin-hsv-histogram-quantised
    }

    var lightnessAverage = lightnessSum / totalPixels
    var lightnessOver90frac = lightPixelCount / totalPixels
    var isDarkCompatible = lightnessAverage < 0.8 && lightnessOver90frac < 0.8

    var huesWithCountArray = []
    for (var i in huebins) {
      huesWithCountArray.push(huebins[i])
    }

    // sort descending by chroma-weighted pixel-count
    huesWithCountArray.sort(function (a, b) {
      return b.totals.c - a.totals.c
    })

    var bins = []
    
    function addTotals (a,b) {
      return {
        px: a.px + b.px,
        c: a.c + b.c,
        s: a.s + b.s,
        l: a.l + b.l,
      }
    }

    outer:
    for (i = 1; i < huesWithCountArray.length; i++) {
      var entry = huesWithCountArray[i]

      for (var j in bins) {
        var bin = bins[j]
        if ((bin.firstHue-HUE_BIN_SIZE+360) % 360 == entry.hue) {
          bin.firstHue = entry.hue
          bin.allHueTotals = addTotals(bin.allHueTotals, entry.totals)
          continue outer
        } else if ((bin.lastHue+HUE_BIN_SIZE+360) % 360 == entry.hue) {
          bin.lastHue = entry.hue
          bin.allHueTotals = addTotals(bin.allHueTotals, entry.totals)
          continue outer
        }
      }
      bins.push({
        allHueTotals: entry.totals,
        peakTotals: entry.totals,
        peakHue: entry.hue,
        firstHue: entry.hue,
        lastHue: entry.hue,
      })

      // if (entry.count < totalHuedPixels/50) {
      if (entry.totals.c < totalHuedPixels_c/400) {
        break
      }
    }

    for (i in bins) {
      var bin = bins[i]
      bin.peak = {
        h: bin.peakHue,
        s: Math.round(100*bin.peakTotals.s / bin.peakTotals.px),
        l: Math.round(100*bin.peakTotals.l / bin.peakTotals.px),
      }
      bin.left = (bin.firstHue==bin.peakHue) ? bin.peak : {
        h: bin.firstHue,
        s: Math.round(100*bin.allHueTotals.s / bin.allHueTotals.px),
        l: Math.round(100*bin.allHueTotals.l / bin.allHueTotals.px),
      }
      bin.right = (bin.lastHue==bin.peakHue) ? bin.peak : {
        h: bin.lastHue,
        s: Math.round(100*bin.allHueTotals.s / bin.allHueTotals.px),
        l: Math.round(100*bin.allHueTotals.l / bin.allHueTotals.px),
      }
      bin.peak.hex  = hslToHex(bin.peak.h,  bin.peak.s,  bin.peak.l)
      bin.left.hex  = hslToHex(bin.left.h,  bin.left.s,  bin.left.l)
      bin.right.hex = hslToHex(bin.right.h, bin.right.s, bin.right.l)
    }

    var result = {
      bins: bins,
      isDarkCompatible: isDarkCompatible,
    }
    return result
  }


/**
 * Converts an RGB color value to HSL. Conversion formula
 * adapted from http://en.wikipedia.org/wiki/HSL_color_space.
 * Assumes r, g, and b are contained in the set [0, 255] and
 * returns h, s, and l in the set [0, 1].
 *
 * @param   Number  r       The red color value
 * @param   Number  g       The green color value
 * @param   Number  b       The blue color value
 * @return  Array           The HSL representation
 */
function rgbToHslc(r, g, b) {
  r /= 255, g /= 255, b /= 255

  var max = Math.max(r, g, b),
  min = Math.min(r, g, b)
  var h,
  s,
  l = (max + min) / 2,
  c = max - min

  if (max == min) {
    h = s = 0 // achromatic
  } else {
    var d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }

    h /= 6
  }

  return [ h, s, l, c ]
}

// Takes degree, percentage, percentage and returns css hex color
function hslToHex(h, s, l) {
  h /= 360;
  s /= 100;
  l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = x => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Converts an HSL color value to RGB. Conversion formula
 * adapted from http://en.wikipedia.org/wiki/HSL_color_space.
 * Assumes h, s, and l are contained in the set [0, 1] and
 * returns r, g, and b in the set [0, 255].
 *
 * @param   Number  h       The hue
 * @param   Number  s       The saturation
 * @param   Number  l       The lightness
 * @return  Array           The RGB representation
 */
function hslToRgb(h, s, l) {
  var r, g, b;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    }

    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;

    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }

  return [ r * 255, g * 255, b * 255 ];
}


module.exports = pify(paletteFromBitmap)
