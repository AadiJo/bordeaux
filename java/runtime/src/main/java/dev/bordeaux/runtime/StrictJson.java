package dev.bordeaux.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import java.lang.reflect.Field;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** Rejects Jackson coercions before conversion, recursively following the authored Java type. */
final class StrictJson {
    private static final int MAX_DEPTH = 24;
    private static final int MAX_ARRAY_ITEMS = 1_024;
    private static final int MAX_OBJECT_FIELDS = 256;
    private static final int MAX_EXACT_CHARACTERS = 1_024;
    private static final int MAX_DECIMAL_EXPONENT = 10_000;

    private StrictJson() {}

    static void validate(JsonNode node, Type type, String path) {
        validate(node, type, path, 0);
    }

    private static void validate(JsonNode node, Type type, String path, int depth) {
        if (depth > MAX_DEPTH) fail(path, "exceeds the nesting limit of " + MAX_DEPTH);
        if (node == null || node.isNull()) fail(path, "must not be null");
        if (!(type instanceof Class<?> raw)) fail(path, "has an unsupported Java type");
        validateClass(node, raw, path, depth);
    }
    private static void validateClass(JsonNode node, Class<?> raw, String path, int depth) {
        if (raw == boolean.class || raw == Boolean.class) {
            if (!node.isBoolean()) fail(path, "must be a boolean");
        } else if (raw == byte.class || raw == Byte.class) {
            integral(node, path, BigInteger.valueOf(Byte.MIN_VALUE), BigInteger.valueOf(Byte.MAX_VALUE));
        } else if (raw == short.class || raw == Short.class) {
            integral(node, path, BigInteger.valueOf(Short.MIN_VALUE), BigInteger.valueOf(Short.MAX_VALUE));
        } else if (raw == int.class || raw == Integer.class) {
            integral(node, path, BigInteger.valueOf(Integer.MIN_VALUE), BigInteger.valueOf(Integer.MAX_VALUE));
        } else if (raw == long.class || raw == Long.class) {
            exactInteger(node, path, BigInteger.valueOf(Long.MIN_VALUE), BigInteger.valueOf(Long.MAX_VALUE));
        } else if (raw == BigInteger.class) {
            exactInteger(node, path, null, null);
        } else if (raw == BigDecimal.class) {
            exactDecimal(node, path);
        } else if (raw == float.class || raw == Float.class) {
            if (!node.isNumber() || !Float.isFinite(node.floatValue())) fail(path, "must be a finite number");
        } else if (raw == double.class || raw == Double.class) {
            if (!node.isNumber() || !Double.isFinite(node.doubleValue())) fail(path, "must be a finite number");
        } else if (raw == String.class) {
            if (!node.isTextual()) fail(path, "must be a string");
        } else if (raw.isEnum()) {
            if (!node.isTextual()) fail(path, "must be an enum name");
            boolean found = false;
            for (Object constant : raw.getEnumConstants()) {
                if (((Enum<?>) constant).name().equals(node.textValue())) found = true;
            }
            if (!found) fail(path, "is not a valid " + raw.getSimpleName() + " value");
        } else {
            fail(path, "has an unsupported Java type");
        }
    }
    private static void integral(JsonNode node, String path, BigInteger minimum, BigInteger maximum) {
        if (!node.isIntegralNumber()) fail(path, "must be an integer number");
        BigInteger value = node.bigIntegerValue();
        if (value.compareTo(minimum) < 0 || value.compareTo(maximum) > 0) fail(path, "is outside the Java integer range");
    }

    private static void exactInteger(JsonNode node, String path, BigInteger minimum, BigInteger maximum) {
        if (!node.isTextual() || node.textValue().length() > MAX_EXACT_CHARACTERS
                || !node.textValue().matches("[+-]?\\d+")) {
            fail(path, "must be a signed digit string");
        }
        BigInteger value = new BigInteger(node.textValue());
        if ((minimum != null && value.compareTo(minimum) < 0) || (maximum != null && value.compareTo(maximum) > 0)) {
            fail(path, "is outside the Java integer range");
        }
    }

    private static void exactDecimal(JsonNode node, String path) {
        if (!node.isTextual() || node.textValue().length() > MAX_EXACT_CHARACTERS
                || !node.textValue().matches("[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?")) {
            fail(path, "must be a decimal string");
        }
        java.util.regex.Matcher exponent = java.util.regex.Pattern.compile("[eE]([+-]?\\d+)$").matcher(node.textValue());
        if (exponent.find() && new BigInteger(exponent.group(1)).abs().compareTo(BigInteger.valueOf(MAX_DECIMAL_EXPONENT)) > 0) {
            fail(path, "decimal exponent exceeds " + MAX_DECIMAL_EXPONENT);
        }
    }

    private static void fail(String path, String detail) {
        throw new BordeauxRuntimeException(path + " " + detail);
    }
}
